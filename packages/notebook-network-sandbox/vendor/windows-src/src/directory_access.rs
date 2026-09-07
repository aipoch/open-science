//! Non-inheriting directory listing grants. Never propagates ACLs into descendants.
use std::{mem::size_of, path::Path, ptr::NonNull};

use anyhow::{Context, Result, bail};
use windows::Win32::{
    Foundation::{CloseHandle, HLOCAL, LocalFree},
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION_DS, ACL_SIZE_INFORMATION,
        AclSizeInformation, AddAccessAllowedAceEx, AddAce,
        Authorization::{
            ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT, SetSecurityInfo,
        },
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, INHERITED_ACE, InitializeAcl, PSECURITY_DESCRIPTOR, PSID,
        SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SECURITY_DESCRIPTOR_CONTROL,
        SetFileSecurityW, SetSecurityDescriptorControl,
    },
    Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    },
};
use windows::core::PCWSTR;

// FILE_LIST_DIRECTORY | FILE_READ_EA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE.
const LIST_DIRECTORY: u32 = 0x0012_0089;
const MAXIMUM_ALLOWED: u32 = 0x0200_0000;

struct Allocation(*mut std::ffi::c_void);
impl Drop for Allocation {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0)));
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// Add an owned grant, or remove precisely that grant while preserving other ACEs.
/// `allow_existing` is only valid after a durable ownership journal has claimed this path.
pub fn update(path: &str, identity: &str, add: bool, allow_existing: bool) -> Result<()> {
    access(path, identity, Some(add), allow_existing).map(|_| ())
}

pub fn is_granted(path: &str, identity: &str) -> Result<bool> {
    access(path, identity, None, true)
}

fn access(path: &str, identity: &str, change: Option<bool>, allow_existing: bool) -> Result<bool> {
    if !Path::new(path).is_dir() {
        bail!("Runtime directory is missing: {path}");
    }
    let name = wide(path);
    let sid_name = wide(identity);
    let mut sid = PSID::default();
    unsafe { ConvertStringSidToSidW(PCWSTR(sid_name.as_ptr()), &mut sid) }?;
    let _sid = Allocation(sid.0);
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let mut dacl = std::ptr::null_mut();
    unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl),
            None,
            &mut descriptor,
        )
    }
    .ok()
    .with_context(|| format!("read runtime directory permissions: {path}"))?;
    let _descriptor = Allocation(descriptor.0);
    let mut original_control = 0u16;
    let mut revision = 0u32;
    unsafe { GetSecurityDescriptorControl(descriptor, &mut original_control, &mut revision) }?;
    if dacl.is_null() {
        bail!("Runtime directory has no concrete DACL: {path}");
    }
    let mut info = ACL_SIZE_INFORMATION::default();
    unsafe {
        GetAclInformation(
            dacl,
            (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    }?;
    let mut aces = Vec::new();
    let mut found = false;
    for index in 0..info.AceCount {
        let mut ace = std::ptr::null_mut();
        unsafe { GetAce(dacl, index, &mut ace) }?;
        let ace = NonNull::new(ace).context("Windows returned a null directory ACE")?;
        let header = unsafe { ace.cast::<ACE_HEADER>().as_ref() };
        if (header.AceSize as usize) < size_of::<ACE_HEADER>() {
            bail!("Invalid directory ACE header; preserving {path}");
        }
        // Simple allow and deny ACEs share the SID/mask layout. Never adopt a deny or inherited ACE.
        if header.AceType <= 1 {
            if (header.AceSize as usize) < size_of::<ACCESS_ALLOWED_ACE>() {
                bail!("Invalid directory ACE; preserving {path}");
            }
            let entry = unsafe { ace.cast::<ACCESS_ALLOWED_ACE>().as_ref() };
            let entry_sid = PSID((&entry.SidStart as *const u32).cast_mut().cast());
            if unsafe { EqualSid(sid, entry_sid) }.is_ok() {
                if found
                    || header.AceType != 0
                    || header.AceFlags != 0
                    || entry.Mask != LIST_DIRECTORY
                    || (change == Some(true) && !allow_existing)
                {
                    bail!("Unowned runtime directory permissions; preserving {path}");
                }
                found = true;
                continue;
            }
        }
        aces.push(unsafe {
            std::slice::from_raw_parts(ace.cast::<u8>().as_ptr(), header.AceSize as usize)
        });
    }
    let Some(add) = change else {
        return Ok(found);
    };
    if found == add {
        return Ok(found);
    }
    let extra = size_of::<ACCESS_ALLOWED_ACE>() + unsafe { GetLengthSid(sid) } as usize;
    let mut storage =
        vec![0usize; (info.AclBytesInUse as usize + extra).div_ceil(size_of::<usize>())];
    let target = storage.as_mut_ptr().cast::<ACL>();
    unsafe {
        InitializeAcl(
            target,
            (storage.len() * size_of::<usize>()) as u32,
            ACL_REVISION_DS,
        )
    }?;
    let mut inserted = !add;
    for ace in aces {
        if !inserted && ace[1] & INHERITED_ACE.0 as u8 != 0 {
            unsafe {
                AddAccessAllowedAceEx(
                    target,
                    ACL_REVISION_DS,
                    Default::default(),
                    LIST_DIRECTORY,
                    sid,
                )
            }?;
            inserted = true;
        }
        unsafe {
            AddAce(
                target,
                ACL_REVISION_DS,
                u32::MAX,
                ace.as_ptr().cast(),
                ace.len() as u32,
            )
        }?;
    }
    if !inserted {
        unsafe {
            AddAccessAllowedAceEx(
                target,
                ACL_REVISION_DS,
                Default::default(),
                LIST_DIRECTORY,
                sid,
            )
        }?;
    }
    // MAXIMUM_ALLOWED is intentional: SetSecurityInfo then does not propagate existing inheritable
    // ACEs to descendants, unlike a named-path update or icacls on a drive root.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(name.as_ptr()),
            MAXIMUM_ALLOWED,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .with_context(|| format!("open runtime directory permissions: {path}"))?;
    let result = unsafe {
        SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(target),
            None,
        )
    }
    .ok();
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.with_context(|| format!("update runtime directory permissions: {path}"))?;
    // SetSecurityInfo upgrades legacy inheritance-control flags even with propagation disabled.
    // Preserve the current ACL and restore only those flags, as the filesystem lease owner does.
    let mut updated = PSECURITY_DESCRIPTOR::default();
    unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(name.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            None,
            None,
            &mut updated,
        )
    }
    .ok()?;
    let _updated = Allocation(updated.0);
    let mut updated_control = 0u16;
    unsafe { GetSecurityDescriptorControl(updated, &mut updated_control, &mut revision) }?;
    let mask = SE_DACL_AUTO_INHERITED.0 | SE_DACL_AUTO_INHERIT_REQ.0;
    if original_control & mask != updated_control & mask {
        unsafe {
            SetSecurityDescriptorControl(
                updated,
                SECURITY_DESCRIPTOR_CONTROL(mask),
                SECURITY_DESCRIPTOR_CONTROL(original_control & mask),
            )
        }?;
        unsafe { SetFileSecurityW(PCWSTR(name.as_ptr()), DACL_SECURITY_INFORMATION, updated) }
            .ok()?;
    }
    Ok(add)
}
