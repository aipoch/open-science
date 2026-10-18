# Windows' supported per-connection API keeps the LAN settings and proxy cache consistent.
# This runs only inside the disposable ordinary test account.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UpdateSourceProxy {
  [StructLayout(LayoutKind.Explicit)] public struct Value { [FieldOffset(0)] public uint number; [FieldOffset(0)] public IntPtr text; [FieldOffset(0)] public long time; }
  [StructLayout(LayoutKind.Sequential)] public struct Option { public uint code; public Value value; }
  [StructLayout(LayoutKind.Sequential)] public struct List { public uint size; public IntPtr connection; public uint count; public uint error; public IntPtr options; }
  public class Settings { public uint Flags; public string Proxy; public string Bypass; public string AutoConfig; }
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool InternetQueryOptionW(IntPtr handle,uint option,ref List list,ref uint length);
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool InternetSetOptionW(IntPtr handle,uint option,ref List list,uint length);
  [DllImport("wininet.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool InternetSetOptionW(IntPtr handle,uint option,IntPtr value,uint length);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
  static List Allocate() {
    var list=new List {size=(uint)Marshal.SizeOf(typeof(List)),count=4,options=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Option))*4)};
    for(int i=0;i<4;i++) Marshal.StructureToPtr(new Option {code=(uint)(i+1)},IntPtr.Add(list.options,i*Marshal.SizeOf(typeof(Option))),false);
    return list;
  }
  public static Settings Read() {
    var list=Allocate(); uint length=list.size;
    try {
      if(!InternetQueryOptionW(IntPtr.Zero,75,ref list,ref length)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var values=new Option[4];
      for(int i=0;i<4;i++) values[i]=(Option)Marshal.PtrToStructure(IntPtr.Add(list.options,i*Marshal.SizeOf(typeof(Option))),typeof(Option));
      try {return new Settings {Flags=values[0].value.number,Proxy=Marshal.PtrToStringUni(values[1].value.text),Bypass=Marshal.PtrToStringUni(values[2].value.text),AutoConfig=Marshal.PtrToStringUni(values[3].value.text)};}
      finally {for(int i=1;i<4;i++) if(values[i].value.text!=IntPtr.Zero) GlobalFree(values[i].value.text);}
    } finally {Marshal.FreeHGlobal(list.options);}
  }
  public static void Write(uint flags,string proxy,string bypass,string autoConfig) {
    var list=Allocate(); var strings=new IntPtr[3];
    try {
      Marshal.StructureToPtr(new Option {code=1,value=new Value {number=flags}},list.options,false);
      var text=new[]{proxy,bypass,autoConfig};
      for(int i=0;i<3;i++) {strings[i]=text[i]==null?IntPtr.Zero:Marshal.StringToHGlobalUni(text[i]);Marshal.StructureToPtr(new Option {code=(uint)(i+2),value=new Value {text=strings[i]}},IntPtr.Add(list.options,(i+1)*Marshal.SizeOf(typeof(Option))),false);}
      if(!InternetSetOptionW(IntPtr.Zero,75,ref list,list.size)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if(!InternetSetOptionW(IntPtr.Zero,39,IntPtr.Zero,0) || !InternetSetOptionW(IntPtr.Zero,37,IntPtr.Zero,0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {foreach(var memory in strings) if(memory!=IntPtr.Zero) Marshal.FreeHGlobal(memory); Marshal.FreeHGlobal(list.options);}
  }
}
'@
