use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::{Deserialize, Serialize};

#[cfg(windows)]
mod wfp;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchSpec {
    executable: String,
    arguments: Vec<String>,
    cwd: String,
    read_only_roots: Vec<String>,
    read_write_roots: Vec<String>,
    denied_read_roots: Vec<String>,
    denied_write_roots: Vec<String>,
}

fn decode_launch_spec(encoded: &str) -> Result<LaunchSpec> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .context("invalid launch specification encoding")?;
    serde_json::from_slice(&bytes).context("invalid launch specification")
}

fn quote_windows_argument(value: &str) -> String {
    if !value.is_empty() && !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return value.to_owned();
    }
    let mut output = String::from("\"");
    let mut backslashes = 0usize;
    for ch in value.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            output.push_str(&"\\".repeat(backslashes * 2 + 1));
            output.push('"');
        } else {
            output.push_str(&"\\".repeat(backslashes));
            output.push(ch);
        }
        backslashes = 0;
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    output
}

fn command_line(spec: &LaunchSpec) -> String {
    std::iter::once(&spec.executable)
        .chain(spec.arguments.iter())
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes)
}

fn command_capability_name(installation_id: &str, lease_id: &str) -> String {
    format!("open-science.notebook.{installation_id}.{lease_id}")
}

fn valid_lease_id(lease_id: &str) -> bool {
    lease_id.len() == 36
        && lease_id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum AclGrant {
    ReadOnlyTree,
    ModifyTree,
}

fn path_is_within(path: &str, root: &Path) -> bool {
    let child = path
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let parent = root
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    child == parent || child.starts_with(&format!("{parent}\\"))
}

fn paths_equal(left: &str, right: &Path) -> bool {
    path_is_within(left, right) && path_is_within(&right.to_string_lossy(), Path::new(left))
}

fn plan_writable_acl_grants(spec: &LaunchSpec) -> Result<BTreeMap<String, AclGrant>> {
    let mut grants = BTreeMap::new();
    for root in &spec.read_write_roots {
        let protected = spec
            .denied_write_roots
            .iter()
            .filter(|denied| path_is_within(denied, Path::new(root)))
            .cloned()
            .collect::<Vec<_>>();
        if protected.iter().any(|path| !Path::new(path).exists()) {
            bail!("Windows AppContainer cannot project a missing protected write root");
        }
        if protected
            .iter()
            .any(|path| paths_equal(path, Path::new(root)))
        {
            grants.insert(root.clone(), AclGrant::ReadOnlyTree);
            continue;
        }
        if !Path::new(root).is_dir() && !protected.is_empty() {
            bail!(
                "Windows AppContainer cannot project a protected descendant through a non-directory root: {root}"
            );
        }
        grants.insert(root.clone(), AclGrant::ModifyTree);
        for path in protected {
            grants.insert(path, AclGrant::ReadOnlyTree);
        }
    }
    Ok(grants)
}

#[cfg(windows)]
mod windows_host {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::mem::{size_of, zeroed};
    use std::net::TcpListener;
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use anyhow::{Context, Result, bail};
    use serde::{Deserialize, Serialize};
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, HLOCAL, LocalFree, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        NetworkIsolationGetAppContainerConfig, NetworkIsolationSetAppContainerConfig,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
        SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
    };
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
    };
    use windows::Win32::Security::{
        ACE_HEADER, ACL, ACL_REVISION_DS, ACL_SIZE_INFORMATION, AclSizeInformation, AddAce,
        DACL_SECURITY_INFORMATION, DeriveCapabilitySidsFromName, EqualSid, FreeSid, GetAce,
        GetAclInformation, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetTokenInformation, INHERITED_ACE, InitializeAcl, InitializeSecurityDescriptor,
        OBJECT_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED,
        SECURITY_CAPABILITIES, SECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR_CONTROL,
        SID_AND_ATTRIBUTES, SetFileSecurityW, SetSecurityDescriptorControl,
        SetSecurityDescriptorDacl, TOKEN_APPCONTAINER_INFORMATION, TOKEN_GROUPS, TOKEN_QUERY,
        TokenAppContainerSid, TokenCapabilities, UNPROTECTED_DACL_SECURITY_INFORMATION,
    };
    use windows::Win32::System::Com::{CoCreateGuid, CoTaskMemFree};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows::Win32::System::Memory::{GetProcessHeap, HEAP_FLAGS, HeapFree};
    use windows::Win32::System::SystemServices::{SE_GROUP_ENABLED, SECURITY_DESCRIPTOR_REVISION};
    use windows::Win32::System::Threading::{
        CREATE_SUSPENDED, CreateMutexW, CreateProcessW, DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcessId, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess,
        OpenProcessToken, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_ACCESS_RIGHTS,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, ReleaseMutex,
        ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject,
    };
    use windows::core::{BOOL, PCWSTR, PWSTR};

    use super::{
        AclGrant, LaunchSpec, command_capability_name, command_line, path_is_within, paths_equal,
        plan_writable_acl_grants, strip_utf8_bom, valid_lease_id, wfp,
    };

    const PROFILE_PREFIX: &str = "Aipoch.OpenScience.Notebook";
    const PROCESS_SYNCHRONIZE: PROCESS_ACCESS_RIGHTS = PROCESS_ACCESS_RIGHTS(0x0010_0000);
    const RECEIPT_SCHEMA: u32 = 4;
    const ACL_LEASE_SCHEMA: u32 = 2;
    const ACL_STATE_SCHEMA: u32 = 1;
    const OPERATION_MUTEX: &str = "Local\\Aipoch.OpenScience.Notebook.Resources";

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OwnershipRecord {
        schema_version: u32,
        installation_id: String,
        state: OwnershipState,
        profile_name: String,
        profile_sid: String,
        ownership_token: String,
        gateway_port: u16,
        wfp_sublayer_key: String,
        wfp_filter_keys: Vec<String>,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    enum OwnershipState {
        Creating,
        Owned,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ProfileStatus {
        profile_exists: bool,
        loopback_allowed: bool,
        network_fence_ready: bool,
        owned: bool,
        ownership_state: &'static str,
        gateway_port: Option<u16>,
    }

    struct OperationLock(HANDLE);

    impl OperationLock {
        fn acquire(installation_id: &str) -> Result<Self> {
            let name = wide(&format!("{OPERATION_MUTEX}.{installation_id}"));
            let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
                .context("create AppContainer operation lock")?;
            let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
            if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
                unsafe { CloseHandle(handle) }.ok();
                bail!("wait for AppContainer operation lock");
            }
            Ok(Self(handle))
        }
    }

    impl Drop for OperationLock {
        fn drop(&mut self) {
            unsafe {
                let _ = ReleaseMutex(self.0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn validate_installation_id(installation_id: &str) -> Result<()> {
        if installation_id.len() != 24
            || !installation_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("invalid installation identity");
        }
        Ok(())
    }

    fn ownership_directory(installation_id: &str, requested_root: &str) -> Result<PathBuf> {
        validate_installation_id(installation_id)?;
        let root = PathBuf::from(requested_root);
        if !root.is_absolute()
            || root.file_name().and_then(|value| value.to_str()) != Some(installation_id)
        {
            bail!("ownership root does not match this installation");
        }
        Ok(root)
    }

    fn receipt_path(ownership_root: &Path) -> PathBuf {
        ownership_root.join("receipt.json")
    }

    fn journal_path(ownership_root: &Path) -> PathBuf {
        ownership_root.join("creating.json")
    }

    fn read_record(path: &Path) -> Result<Option<OwnershipRecord>> {
        match fs::read(path) {
            Ok(bytes) => Ok(Some(
                serde_json::from_slice(strip_utf8_bom(&bytes))
                    .with_context(|| format!("read ownership record {}", path.display()))?,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
        }
    }

    fn validate_record(record: &OwnershipRecord, installation_id: &str) -> Result<()> {
        let expected_name = format!("{PROFILE_PREFIX}.{}", record.ownership_token);
        let expected_sid = sid_text(profile_sid(&record.profile_name)?.0)?;
        let descriptor = wfp_descriptor(record);
        if record.schema_version != RECEIPT_SCHEMA
            || record.installation_id != installation_id
            || record.profile_name != expected_name
            || record.profile_sid != expected_sid
            || record.ownership_token.is_empty()
            || record.gateway_port == 0
            || wfp::validate_keys(&descriptor).is_err()
        {
            bail!("AppContainer ownership record does not match this installation");
        }
        Ok(())
    }

    fn wfp_descriptor(record: &OwnershipRecord) -> wfp::FenceDescriptor<'_> {
        wfp::FenceDescriptor {
            installation_id: &record.installation_id,
            ownership_token: &record.ownership_token,
            sublayer_key: &record.wfp_sublayer_key,
            filter_keys: &record.wfp_filter_keys,
            gateway_port: record.gateway_port,
        }
    }

    fn new_resource_key() -> Result<String> {
        Ok(format!("{:032x}", unsafe { CoCreateGuid() }?.to_u128()))
    }

    fn ownership_record(
        installation_id: &str,
        ownership_root: &Path,
    ) -> Result<Option<OwnershipRecord>> {
        let receipt = read_record(&receipt_path(ownership_root))?;
        let journal = read_record(&journal_path(ownership_root))?;
        if let Some(record) = &receipt {
            validate_record(record, installation_id)?;
            if record.state != OwnershipState::Owned {
                bail!("AppContainer ownership receipt has an invalid state");
            }
        }
        if let Some(record) = &journal {
            validate_record(record, installation_id)?;
            if record.state != OwnershipState::Creating {
                bail!("AppContainer creation journal has an invalid state");
            }
        }
        if let (Some(receipt), Some(journal)) = (&receipt, &journal)
            && receipt.ownership_token != journal.ownership_token
        {
            bail!("AppContainer ownership records disagree; preserving resources");
        }
        Ok(journal.or(receipt))
    }

    fn write_new_record(path: &Path, record: &OwnershipRecord) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create ownership directory {}", parent.display()))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("create ownership record {}", path.display()))?;
        serde_json::to_writer_pretty(&mut file, record)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    }

    fn commit_receipt(ownership_root: &Path, record: &OwnershipRecord) -> Result<()> {
        let receipt = receipt_path(ownership_root);
        if receipt.exists() && !journal_path(ownership_root).exists() {
            return Ok(());
        }
        let temporary = receipt.with_extension("json.tmp");
        if temporary.exists() {
            fs::remove_file(&temporary)
                .with_context(|| format!("remove stale receipt {}", temporary.display()))?;
        }
        write_new_record(&temporary, record)?;
        if receipt.exists() {
            fs::remove_file(&receipt).with_context(|| {
                format!(
                    "replace AppContainer ownership receipt {}",
                    receipt.display()
                )
            })?;
        }
        fs::rename(&temporary, &receipt).context("commit AppContainer ownership receipt")
    }

    fn replace_journal(ownership_root: &Path, record: &OwnershipRecord) -> Result<()> {
        let journal = journal_path(ownership_root);
        if journal.exists() {
            fs::remove_file(&journal).with_context(|| {
                format!(
                    "replace AppContainer creation journal {}",
                    journal.display()
                )
            })?;
        }
        write_new_record(&journal, record)
    }

    fn allocate_gateway_port() -> Result<u16> {
        Ok(TcpListener::bind(("127.0.0.1", 0))
            .context("allocate a Notebook gateway port")?
            .local_addr()
            .context("read the allocated Notebook gateway port")?
            .port())
    }

    fn gateway_port_available(port: u16) -> bool {
        TcpListener::bind(("127.0.0.1", port)).is_ok()
    }

    struct OwnedSid(PSID);

    impl Drop for OwnedSid {
        fn drop(&mut self) {
            unsafe {
                FreeSid(self.0);
            }
        }
    }

    fn profile_sid(profile_name: &str) -> Result<OwnedSid> {
        let name = wide(profile_name);
        let sid = unsafe { DeriveAppContainerSidFromAppContainerName(PCWSTR(name.as_ptr())) }
            .context("derive AppContainer SID")?;
        Ok(OwnedSid(sid))
    }

    fn sid_text(sid: PSID) -> Result<String> {
        let mut text = PWSTR::null();
        unsafe { ConvertSidToStringSidW(sid, &mut text) }.context("format AppContainer SID")?;
        let value = unsafe { text.to_string() }.context("read AppContainer SID")?;
        unsafe {
            LocalFree(Some(HLOCAL(text.0.cast())));
        }
        Ok(value)
    }

    fn profile_exists(sid: PSID) -> Result<bool> {
        let sid_string = wide(&sid_text(sid)?);
        match unsafe { GetAppContainerFolderPath(PCWSTR(sid_string.as_ptr())) } {
            Ok(path) => {
                unsafe { CoTaskMemFree(Some(path.0.cast())) };
                Ok(true)
            }
            Err(_) => Ok(false),
        }
    }

    unsafe fn release_loopback_list(count: u32, entries: *mut SID_AND_ATTRIBUTES) {
        if entries.is_null() {
            return;
        }
        let heap = unsafe { GetProcessHeap() }.expect("process heap");
        for entry in unsafe { std::slice::from_raw_parts(entries, count as usize) } {
            if !entry.Sid.0.is_null() {
                let _ = unsafe { HeapFree(heap, HEAP_FLAGS(0), Some(entry.Sid.0)) };
            }
        }
        let _ = unsafe { HeapFree(heap, HEAP_FLAGS(0), Some(entries.cast())) };
    }

    fn loopback_entries() -> Result<(u32, *mut SID_AND_ATTRIBUTES)> {
        let mut count = 0u32;
        let mut entries = std::ptr::null_mut();
        let code = unsafe { NetworkIsolationGetAppContainerConfig(&mut count, &mut entries) };
        if code != 0 {
            bail!("read AppContainer loopback configuration: Windows error {code}");
        }
        Ok((count, entries))
    }

    fn loopback_entries_snapshot(
        count: u32,
        entries: *const SID_AND_ATTRIBUTES,
    ) -> Result<Vec<SID_AND_ATTRIBUTES>> {
        if count == 0 {
            return Ok(Vec::new());
        }
        if entries.is_null() {
            bail!("Windows returned a null AppContainer loopback configuration");
        }
        Ok(unsafe { std::slice::from_raw_parts(entries, count as usize) }.to_vec())
    }

    fn loopback_contains(sid: PSID) -> Result<bool> {
        let (count, entries) = loopback_entries()?;
        let found = loopback_entries_snapshot(count, entries)?
            .iter()
            .any(|entry| unsafe { EqualSid(entry.Sid, sid) }.is_ok());
        unsafe { release_loopback_list(count, entries) };
        Ok(found)
    }

    fn add_loopback(sid: PSID) -> Result<()> {
        let (count, entries) = loopback_entries()?;
        let mut current = loopback_entries_snapshot(count, entries)?;
        if current
            .iter()
            .any(|entry| unsafe { EqualSid(entry.Sid, sid) }.is_ok())
        {
            unsafe { release_loopback_list(count, entries) };
            return Ok(());
        }
        current.push(SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: 0,
        });
        let code = unsafe { NetworkIsolationSetAppContainerConfig(&current) };
        unsafe { release_loopback_list(count, entries) };
        if code != 0 {
            bail!("configure AppContainer loopback access: Windows error {code}");
        }
        Ok(())
    }

    fn remove_loopback(sid: PSID) -> Result<()> {
        let (count, entries) = loopback_entries()?;
        let current = loopback_entries_snapshot(count, entries)?;
        let retained = current
            .iter()
            .copied()
            .filter(|entry| unsafe { EqualSid(entry.Sid, sid) }.is_err())
            .collect::<Vec<_>>();
        if retained.len() == current.len() {
            unsafe { release_loopback_list(count, entries) };
            return Ok(());
        }
        let code = unsafe { NetworkIsolationSetAppContainerConfig(&retained) };
        unsafe { release_loopback_list(count, entries) };
        if code != 0 {
            bail!("remove AppContainer loopback access: Windows error {code}");
        }
        Ok(())
    }

    fn process_uses_profile(process: HANDLE, sid: PSID) -> Result<bool> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .context("open process token")?;
        let token = Handle(token);
        let mut returned = 0u32;
        let _ =
            unsafe { GetTokenInformation(token.0, TokenAppContainerSid, None, 0, &mut returned) };
        if returned < size_of::<TOKEN_APPCONTAINER_INFORMATION>() as u32 {
            bail!("Windows did not report an AppContainer token information size");
        }
        let mut storage = vec![0usize; (returned as usize).div_ceil(size_of::<usize>())];
        unsafe {
            GetTokenInformation(
                token.0,
                TokenAppContainerSid,
                Some(storage.as_mut_ptr().cast()),
                (storage.len() * size_of::<usize>()) as u32,
                &mut returned,
            )
        }
        .context("read process AppContainer SID")?;
        let information = unsafe { &*storage.as_ptr().cast::<TOKEN_APPCONTAINER_INFORMATION>() };
        if information.TokenAppContainer.0.is_null() {
            return Ok(false);
        }
        Ok(unsafe { EqualSid(information.TokenAppContainer, sid) }.is_ok())
    }

    fn process_has_enabled_capability(process: HANDLE, sid: PSID) -> Result<bool> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .context("open process token")?;
        let token = Handle(token);
        let mut returned = 0u32;
        let _ = unsafe { GetTokenInformation(token.0, TokenCapabilities, None, 0, &mut returned) };
        if returned < size_of::<TOKEN_GROUPS>() as u32 {
            bail!("Windows did not report a token capabilities size");
        }
        let mut storage = vec![0usize; (returned as usize).div_ceil(size_of::<usize>())];
        unsafe {
            GetTokenInformation(
                token.0,
                TokenCapabilities,
                Some(storage.as_mut_ptr().cast()),
                (storage.len() * size_of::<usize>()) as u32,
                &mut returned,
            )
        }
        .context("read process capabilities")?;
        let groups = unsafe { &*storage.as_ptr().cast::<TOKEN_GROUPS>() };
        let entries = unsafe {
            std::slice::from_raw_parts(groups.Groups.as_ptr(), groups.GroupCount as usize)
        };
        Ok(entries.iter().any(|entry| {
            entry.Attributes & SE_GROUP_ENABLED as u32 != 0
                && unsafe { EqualSid(entry.Sid, sid) }.is_ok()
        }))
    }

    fn stop_profile_processes(sid: PSID) -> Result<()> {
        let snapshot = Handle(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
                .context("enumerate processes before removing AppContainer")?,
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
            return Ok(());
        }
        loop {
            if let Ok(process) = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    false,
                    entry.th32ProcessID,
                )
            } {
                let process = Handle(process);
                if process_uses_profile(process.0, sid)? {
                    unsafe { TerminateProcess(process.0, 1) }.with_context(|| {
                        format!("stop AppContainer process {}", entry.th32ProcessID)
                    })?;
                    if unsafe { WaitForSingleObject(process.0, 15_000) } != WAIT_OBJECT_0 {
                        bail!(
                            "AppContainer process {} did not stop before removal",
                            entry.th32ProcessID
                        );
                    }
                }
            }
            if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
                break;
            }
        }
        Ok(())
    }

    pub fn status(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let ownership = ownership_record(installation_id, &ownership_root)?;
        let Some(record) = ownership.as_ref() else {
            println!(
                "{}",
                serde_json::to_string(&ProfileStatus {
                    profile_exists: false,
                    loopback_allowed: false,
                    network_fence_ready: false,
                    owned: false,
                    ownership_state: "unowned",
                    gateway_port: None,
                })?
            );
            return Ok(());
        };
        let sid = profile_sid(&record.profile_name)?;
        let status = ProfileStatus {
            profile_exists: profile_exists(sid.0)?,
            loopback_allowed: loopback_contains(sid.0)?,
            network_fence_ready: record.state == OwnershipState::Owned,
            owned: record.state == OwnershipState::Owned,
            ownership_state: match ownership.as_ref().map(|record| record.state) {
                Some(OwnershipState::Owned) => "owned",
                Some(OwnershipState::Creating) => "creating",
                None => "unowned",
            },
            gateway_port: Some(record.gateway_port),
        };
        println!("{}", serde_json::to_string(&status)?);
        Ok(())
    }

    pub fn prepare_setup(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        recover_acl_leases(installation_id, &ownership_root, false)?;
        let mut record = ownership_record(installation_id, &ownership_root)?;
        if record.is_none() {
            let (ownership_token, profile_name, profile_sid) = loop {
                let token = format!("{:?}", unsafe { CoCreateGuid() }?);
                let name = format!("{PROFILE_PREFIX}.{token}");
                let candidate = profile_sid(&name)?;
                if !profile_exists(candidate.0)? && !loopback_contains(candidate.0)? {
                    break (token, name, sid_text(candidate.0)?);
                }
            };
            let creating = OwnershipRecord {
                schema_version: RECEIPT_SCHEMA,
                installation_id: installation_id.to_owned(),
                state: OwnershipState::Creating,
                profile_name,
                profile_sid,
                ownership_token,
                gateway_port: allocate_gateway_port()?,
                wfp_sublayer_key: new_resource_key()?,
                wfp_filter_keys: (0..3)
                    .map(|_| new_resource_key())
                    .collect::<Result<Vec<_>>>()?,
            };
            write_new_record(&journal_path(&ownership_root), &creating)?;
            record = Some(creating);
        } else if record
            .as_ref()
            .is_some_and(|existing| !gateway_port_available(existing.gateway_port))
        {
            let mut creating = record.context("ownership record disappeared during repair")?;
            creating.state = OwnershipState::Creating;
            creating.gateway_port = allocate_gateway_port()?;
            replace_journal(&ownership_root, &creating)?;
            record = Some(creating);
        }
        record.context("ownership record disappeared during setup")?;
        Ok(())
    }

    pub fn cancel_setup(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let Some(journal) = read_record(&journal_path(&ownership_root))? else {
            return Ok(());
        };
        validate_record(&journal, installation_id)?;
        if journal.state != OwnershipState::Creating {
            bail!("AppContainer creation journal has an invalid state");
        }
        if let Some(receipt) = read_record(&receipt_path(&ownership_root))? {
            validate_record(&receipt, installation_id)?;
            if receipt.state != OwnershipState::Owned
                || receipt.ownership_token != journal.ownership_token
            {
                bail!("AppContainer ownership records disagree; preserving resources");
            }
        } else {
            let sid = profile_sid(&journal.profile_name)?;
            if loopback_contains(sid.0)? {
                bail!("AppContainer setup cancellation found installed network resources");
            }
            if profile_exists(sid.0)? {
                let name = wide(&journal.profile_name);
                unsafe { DeleteAppContainerProfile(PCWSTR(name.as_ptr())) }
                    .context("delete cancelled AppContainer profile")?;
            }
        }
        fs::remove_file(journal_path(&ownership_root))
            .context("cancel AppContainer setup repair")?;
        Ok(())
    }

    pub fn setup_network(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let record = ownership_record(installation_id, &ownership_root)?
            .context("prepare AppContainer setup before configuring network resources")?;
        let previous = read_record(&receipt_path(&ownership_root))?;
        if let Some(previous) = &previous {
            validate_record(previous, installation_id)?;
        }
        let sid = profile_sid(&record.profile_name)?;
        if !profile_exists(sid.0)? {
            let name = wide(&record.profile_name);
            let display = wide("Open Science Notebook");
            let description = wide("Local Notebook process isolation profile");
            let created = unsafe {
                CreateAppContainerProfile(
                    PCWSTR(name.as_ptr()),
                    PCWSTR(display.as_ptr()),
                    PCWSTR(description.as_ptr()),
                    None,
                )
            }
            .context("create AppContainer profile")?;
            unsafe {
                FreeSid(created);
            }
        }
        let loopback_was_present = loopback_contains(sid.0)?;
        let install_result = (|| -> Result<()> {
            wfp::install(&wfp_descriptor(&record), sid.0)?;
            add_loopback(sid.0)?;
            let mut owned = record.clone();
            owned.state = OwnershipState::Owned;
            commit_receipt(&ownership_root, &owned)?;
            Ok(())
        })();
        if let Err(error) = install_result {
            let rollback = (|| -> Result<()> {
                if !loopback_was_present {
                    remove_loopback(sid.0)?;
                }
                if let Some(previous) = previous.as_ref() {
                    wfp::install(&wfp_descriptor(previous), sid.0)?;
                    commit_receipt(&ownership_root, previous)?;
                } else {
                    wfp::remove(&wfp_descriptor(&record))?;
                    match fs::remove_file(receipt_path(&ownership_root)) {
                        Ok(()) => {}
                        Err(remove_error)
                            if remove_error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(remove_error) => return Err(remove_error.into()),
                    }
                }
                Ok(())
            })();
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "rollback Windows protected-mode setup also failed: {rollback_error:#}"
                ))),
            };
        }
        Ok(())
    }

    pub fn finish_setup(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let record = read_record(&receipt_path(&ownership_root))?
            .context("AppContainer setup ownership receipt is missing")?;
        validate_record(&record, installation_id)?;
        let sid = profile_sid(&record.profile_name)?;
        if record.state != OwnershipState::Owned
            || !profile_exists(sid.0)?
            || !loopback_contains(sid.0)?
        {
            bail!("AppContainer setup is incomplete");
        }
        let journal = journal_path(&ownership_root);
        if journal.exists() {
            let creating =
                read_record(&journal)?.context("AppContainer setup journal is missing")?;
            validate_record(&creating, installation_id)?;
            if creating.ownership_token != record.ownership_token {
                bail!("AppContainer ownership records disagree; preserving resources");
            }
            fs::remove_file(&journal).context("remove completed AppContainer creation journal")?;
        }
        Ok(())
    }

    pub fn prepare_remove(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let Some(record) = ownership_record(installation_id, &ownership_root)? else {
            recover_acl_leases(installation_id, &ownership_root, true)?;
            return Ok(());
        };
        let sid = profile_sid(&record.profile_name)?;
        stop_profile_processes(sid.0)?;
        recover_acl_leases(installation_id, &ownership_root, true)?;
        Ok(())
    }

    pub fn remove_network(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let Some(record) = ownership_record(installation_id, &ownership_root)? else {
            return Ok(());
        };
        let sid = profile_sid(&record.profile_name)?;
        stop_profile_processes(sid.0)?;
        wfp::remove(&wfp_descriptor(&record))?;
        if let Err(error) = remove_loopback(sid.0) {
            return match wfp::install(&wfp_descriptor(&record), sid.0) {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(error.context(format!(
                    "restore Windows Filtering Platform fence after loopback removal failed: {rollback_error:#}"
                ))),
            };
        }
        recover_acl_leases(installation_id, &ownership_root, true)?;
        if profile_exists(sid.0)? {
            let name = wide(&record.profile_name);
            unsafe { DeleteAppContainerProfile(PCWSTR(name.as_ptr())) }
                .context("delete AppContainer profile")?;
        }
        if profile_exists(sid.0)? {
            bail!("AppContainer removal is incomplete");
        }
        for path in [
            receipt_path(&ownership_root),
            journal_path(&ownership_root),
            receipt_path(&ownership_root).with_extension("json.tmp"),
        ] {
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| format!("remove {}", path.display()));
                }
            }
        }
        Ok(())
    }

    pub fn finish_remove(installation_id: &str, requested_root: &str) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let Some(_record) = ownership_record(installation_id, &ownership_root)? else {
            recover_acl_leases(installation_id, &ownership_root, true)?;
            return Ok(());
        };
        bail!("AppContainer removal is incomplete")
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AclSnapshot {
        path: String,
        dacl_sddl: String,
        dacl_protected: bool,
        dacl_auto_inherited: bool,
        dacl_auto_inherit_requested: bool,
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AclLeaseGrant {
        path: String,
        access: AclGrant,
        protected_boundary: bool,
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AclLeaseRecord {
        schema_version: u32,
        installation_id: String,
        lease_id: String,
        owner_process_id: u32,
        capability_name: String,
        capability_sid: String,
        grants: Vec<AclLeaseGrant>,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AclState {
        schema_version: u32,
        installation_id: String,
        snapshots: Vec<AclSnapshot>,
        leases: Vec<AclLeaseRecord>,
    }

    struct AclLease {
        installation_id: String,
        ownership_root: PathBuf,
        record: AclLeaseRecord,
        released: bool,
    }

    struct LocalAllocation(*mut std::ffi::c_void);

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(Some(HLOCAL(self.0)));
                }
            }
        }
    }

    struct CommandCapability {
        name: String,
        entries: Vec<SID_AND_ATTRIBUTES>,
        group_sids: *mut PSID,
        capability_sids: *mut PSID,
    }

    impl CommandCapability {
        fn new(name_text: String) -> Result<Self> {
            let name = wide(&name_text);
            let mut group_sids: *mut PSID = std::ptr::null_mut();
            let mut group_count = 0u32;
            let mut capability_sids: *mut PSID = std::ptr::null_mut();
            let mut capability_count = 0u32;
            unsafe {
                DeriveCapabilitySidsFromName(
                    PCWSTR(name.as_ptr()),
                    &mut group_sids,
                    &mut group_count,
                    &mut capability_sids,
                    &mut capability_count,
                )
            }
            .context("derive command filesystem capability")?;
            if capability_sids.is_null() || capability_count == 0 {
                bail!("Windows did not derive a command filesystem capability");
            }
            let sid = unsafe { *capability_sids };
            Ok(Self {
                name: name_text,
                entries: vec![SID_AND_ATTRIBUTES {
                    Sid: sid,
                    Attributes: SE_GROUP_ENABLED as u32,
                }],
                group_sids,
                capability_sids,
            })
        }

        fn sid(&self) -> PSID {
            self.entries[0].Sid
        }

        fn name(&self) -> &str {
            &self.name
        }
    }

    impl Drop for CommandCapability {
        fn drop(&mut self) {
            unsafe {
                if !self.group_sids.is_null() {
                    let _ = LocalFree(Some(HLOCAL(self.group_sids.cast())));
                }
                if !self.capability_sids.is_null() {
                    let _ = LocalFree(Some(HLOCAL(self.capability_sids.cast())));
                }
            }
        }
    }

    fn new_lease_id() -> Result<String> {
        Ok(format!("{:?}", unsafe { CoCreateGuid() }?)
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
            .collect())
    }

    fn acl_directory(ownership_root: &Path) -> PathBuf {
        ownership_root.join("acl-leases")
    }

    fn acl_state_path(ownership_root: &Path) -> PathBuf {
        ownership_root.join("acl-state.json")
    }

    fn write_acl_record(path: &Path, record: &AclLeaseRecord) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create ACL lease directory {}", parent.display()))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("write ACL lease record {}", path.display()))?;
        serde_json::to_writer_pretty(&mut file, record)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    }

    fn read_acl_state(installation_id: &str, ownership_root: &Path) -> Result<Option<AclState>> {
        let path = acl_state_path(ownership_root);
        let state = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(strip_utf8_bom(&bytes))
                .with_context(|| format!("parse ACL state {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        validate_acl_state(&state, installation_id)?;
        Ok(Some(state))
    }

    fn write_acl_state(ownership_root: &Path, state: &AclState) -> Result<()> {
        let path = acl_state_path(ownership_root);
        let temporary = path.with_extension("json.tmp");
        if state.snapshots.is_empty() && state.leases.is_empty() {
            for candidate in [&temporary, &path] {
                match fs::remove_file(candidate) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error)
                            .with_context(|| format!("remove ACL state {}", candidate.display()));
                    }
                }
            }
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create ACL state directory {}", parent.display()))?;
        }
        match fs::remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("remove stale ACL state {}", temporary.display()));
            }
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("write ACL state {}", temporary.display()))?;
        serde_json::to_writer_pretty(&mut file, state)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, &path)
            .with_context(|| format!("commit ACL state {}", path.display()))
    }

    fn process_is_running(process_id: u32) -> bool {
        let Ok(process) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, process_id) }) else {
            return false;
        };
        let process = Handle(process);
        (unsafe { WaitForSingleObject(process.0, 0) }) == WAIT_TIMEOUT
    }

    fn appcontainer_reads_without_capability(path: &str) -> bool {
        [
            "WINDIR",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramW6432",
        ]
        .iter()
        .filter_map(|name| std::env::var_os(name))
        .map(PathBuf::from)
        .any(|root| path_is_within(path, &root))
    }

    fn validate_denied_roots(spec: &LaunchSpec) -> Result<()> {
        for denied in &spec.denied_read_roots {
            if appcontainer_reads_without_capability(denied)
                || spec
                    .read_only_roots
                    .iter()
                    .chain(&spec.read_write_roots)
                    .any(|granted| path_is_within(denied, Path::new(granted)))
            {
                bail!(
                    "Windows AppContainer cannot enforce denied read root nested in an allowed root: {denied}"
                );
            }
        }
        Ok(())
    }

    fn serialize_dacl(dacl: *const ACL, path: &str) -> Result<String> {
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let descriptor_ptr = PSECURITY_DESCRIPTOR(
            (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast::<std::ffi::c_void>(),
        );
        unsafe {
            InitializeSecurityDescriptor(descriptor_ptr, SECURITY_DESCRIPTOR_REVISION)
                .with_context(|| format!("initialize ACL snapshot for {path}"))?;
            SetSecurityDescriptorDacl(descriptor_ptr, true, Some(dacl), false)
                .with_context(|| format!("attach DACL snapshot for {path}"))?;
        }
        let mut sddl = PWSTR::null();
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor_ptr,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut sddl,
                None,
            )
        }
        .with_context(|| format!("serialize filesystem ACL for {path}"))?;
        let _sddl = LocalAllocation(sddl.0.cast());
        unsafe { sddl.to_string() }
            .with_context(|| format!("read serialized filesystem ACL for {path}"))
    }

    fn serialize_explicit_dacl(dacl: *const ACL, path: &str) -> Result<String> {
        let mut information = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                dacl,
                (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        }
        .with_context(|| format!("inspect filesystem ACL for {path}"))?;

        let word_count = (information.AclBytesInUse as usize).div_ceil(size_of::<usize>());
        let mut storage = vec![0usize; word_count.max(1)];
        let explicit = storage.as_mut_ptr().cast::<ACL>();
        unsafe {
            InitializeAcl(
                explicit,
                (storage.len() * size_of::<usize>()) as u32,
                ACL_REVISION_DS,
            )
        }
        .with_context(|| format!("initialize explicit filesystem ACL for {path}"))?;
        for index in 0..information.AceCount {
            let mut ace = std::ptr::null_mut();
            unsafe { GetAce(dacl, index, &mut ace) }
                .with_context(|| format!("read filesystem ACE for {path}"))?;
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceFlags & INHERITED_ACE.0 as u8 == 0 {
                unsafe {
                    AddAce(
                        explicit,
                        ACL_REVISION_DS,
                        u32::MAX,
                        ace,
                        header.AceSize as u32,
                    )
                }
                .with_context(|| format!("copy explicit filesystem ACE for {path}"))?;
            }
        }
        serialize_dacl(explicit, path)
    }

    fn capture_acl_snapshot(path: &str) -> Result<AclSnapshot> {
        let path_wide = wide(path);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(path_wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut descriptor,
            )
        }
        .ok()
        .with_context(|| format!("read filesystem ACL for {path}"))?;
        let _descriptor = LocalAllocation(descriptor.0);

        let mut dacl_present = BOOL::default();
        let mut dacl = std::ptr::null_mut();
        let mut dacl_defaulted = BOOL::default();
        unsafe {
            GetSecurityDescriptorDacl(
                descriptor,
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
        }
        .with_context(|| format!("read filesystem DACL for {path}"))?;
        if !dacl_present.as_bool() || dacl.is_null() {
            bail!("Windows sandbox cannot lease a filesystem path without a concrete DACL: {path}");
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }
            .with_context(|| format!("read filesystem ACL inheritance for {path}"))?;
        let dacl_protected = control & SE_DACL_PROTECTED.0 != 0;
        let dacl_sddl = if dacl_protected {
            serialize_dacl(dacl.cast_const(), path)?
        } else {
            serialize_explicit_dacl(dacl.cast_const(), path)?
        };
        Ok(AclSnapshot {
            path: path.to_owned(),
            dacl_sddl,
            dacl_protected,
            dacl_auto_inherited: control & SE_DACL_AUTO_INHERITED.0 != 0,
            dacl_auto_inherit_requested: control & SE_DACL_AUTO_INHERIT_REQ.0 != 0,
        })
    }

    fn restore_acl_snapshot(snapshot: &AclSnapshot) -> Result<()> {
        if !Path::new(&snapshot.path).exists() {
            return Ok(());
        }
        let current = capture_acl_snapshot(&snapshot.path)?;
        restore_acl_snapshot_if_needed(snapshot, &current, || {
            restore_acl_snapshot_unchecked(snapshot)
        })
    }

    fn restore_acl_snapshot_if_needed(
        snapshot: &AclSnapshot,
        current: &AclSnapshot,
        restore: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        if current == snapshot {
            return Ok(());
        }
        restore()
    }

    fn restore_acl_snapshot_unchecked(snapshot: &AclSnapshot) -> Result<()> {
        let sddl = wide(&snapshot.dacl_sddl);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .with_context(|| format!("parse saved filesystem ACL for {}", snapshot.path))?;
        let _descriptor = LocalAllocation(descriptor.0);

        let mut dacl_present = BOOL::default();
        let mut dacl = std::ptr::null_mut();
        let mut dacl_defaulted = BOOL::default();
        unsafe {
            GetSecurityDescriptorDacl(
                descriptor,
                &mut dacl_present,
                &mut dacl,
                &mut dacl_defaulted,
            )
        }
        .with_context(|| format!("read saved filesystem ACL for {}", snapshot.path))?;
        let inheritance = if snapshot.dacl_protected {
            PROTECTED_DACL_SECURITY_INFORMATION
        } else {
            UNPROTECTED_DACL_SECURITY_INFORMATION
        };
        let information = OBJECT_SECURITY_INFORMATION(DACL_SECURITY_INFORMATION.0 | inheritance.0);
        let path = wide(&snapshot.path);
        unsafe {
            SetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                information,
                None,
                None,
                dacl_present.as_bool().then_some(dacl.cast_const()),
                None,
            )
        }
        .ok()
        .with_context(|| format!("restore filesystem ACL for {}", snapshot.path))?;

        let mut restored_descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut restored_descriptor,
            )
        }
        .ok()
        .with_context(|| format!("read restored filesystem ACL for {}", snapshot.path))?;
        let _restored_descriptor = LocalAllocation(restored_descriptor.0);
        let auto_inherit_mask =
            SECURITY_DESCRIPTOR_CONTROL(SE_DACL_AUTO_INHERITED.0 | SE_DACL_AUTO_INHERIT_REQ.0);
        let mut auto_inherit_bits = 0u16;
        if snapshot.dacl_auto_inherited {
            auto_inherit_bits |= SE_DACL_AUTO_INHERITED.0;
        }
        if snapshot.dacl_auto_inherit_requested {
            auto_inherit_bits |= SE_DACL_AUTO_INHERIT_REQ.0;
        }
        unsafe {
            SetSecurityDescriptorControl(
                restored_descriptor,
                auto_inherit_mask,
                SECURITY_DESCRIPTOR_CONTROL(auto_inherit_bits),
            )
        }
        .with_context(|| format!("restore filesystem ACL control for {}", snapshot.path))?;
        unsafe {
            SetFileSecurityW(
                PCWSTR(path.as_ptr()),
                DACL_SECURITY_INFORMATION,
                restored_descriptor,
            )
        }
        .ok()
        .with_context(|| format!("commit filesystem ACL control for {}", snapshot.path))?;
        if snapshot.dacl_auto_inherited && !snapshot.dacl_protected {
            run_icacls(
                &snapshot.path,
                &["/inheritancelevel:e", "/Q"],
                "restore automatic ACL inheritance on",
            )?;
        }
        Ok(())
    }

    fn run_icacls(path: &str, arguments: &[&str], action: &str) -> Result<()> {
        let output = Command::new("icacls.exe")
            .arg(path)
            .args(arguments)
            .output()
            .with_context(|| format!("start icacls to {action} {path}"))?;
        if output.status.success() {
            return Ok(());
        }
        let message = String::from_utf8_lossy(&output.stderr);
        bail!("{action} {path}: {}", message.trim())
    }

    fn is_protected_write_boundary(spec: &LaunchSpec, path: &str) -> bool {
        spec.denied_write_roots
            .iter()
            .any(|denied| paths_equal(denied, Path::new(path)))
            && spec.read_write_roots.iter().any(|root| {
                path_is_within(path, Path::new(root)) && !paths_equal(path, Path::new(root))
            })
    }

    fn validate_acl_record_data(record: &AclLeaseRecord, installation_id: &str) -> Result<()> {
        let expected_name = command_capability_name(installation_id, &record.lease_id);
        let mut paths = BTreeSet::new();
        if record.schema_version != ACL_LEASE_SCHEMA
            || record.installation_id != installation_id
            || !valid_lease_id(&record.lease_id)
            || record.owner_process_id == 0
            || record.capability_name != expected_name
            || record.grants.iter().any(|grant| {
                !Path::new(&grant.path).is_absolute() || !paths.insert(grant.path.to_lowercase())
            })
        {
            bail!("ACL lease record does not belong to this installation");
        }
        let expected_capability = CommandCapability::new(expected_name)?;
        if record.capability_sid != sid_text(expected_capability.sid())? {
            bail!("ACL lease record does not belong to this installation");
        }
        Ok(())
    }

    fn validate_acl_record(
        path: &Path,
        record: &AclLeaseRecord,
        installation_id: &str,
    ) -> Result<()> {
        validate_acl_record_data(record, installation_id)?;
        if path.file_name().and_then(|value| value.to_str())
            != Some(&format!("{}.json", record.lease_id))
        {
            bail!("ACL lease record does not belong to this installation");
        }
        Ok(())
    }

    fn validate_acl_state(state: &AclState, installation_id: &str) -> Result<()> {
        let mut snapshot_paths = BTreeSet::new();
        let mut lease_ids = BTreeSet::new();
        if state.schema_version != ACL_STATE_SCHEMA
            || state.installation_id != installation_id
            || state.snapshots.iter().any(|snapshot| {
                snapshot.dacl_sddl.is_empty()
                    || !Path::new(&snapshot.path).is_absolute()
                    || !snapshot_paths.insert(snapshot.path.to_lowercase())
            })
        {
            bail!("ACL state does not belong to this installation");
        }
        for lease in &state.leases {
            validate_acl_record_data(lease, installation_id)?;
            if !lease_ids.insert(lease.lease_id.clone())
                || lease
                    .grants
                    .iter()
                    .any(|grant| !snapshot_paths.contains(&grant.path.to_lowercase()))
            {
                bail!("ACL state does not belong to this installation");
            }
        }
        Ok(())
    }

    fn remove_acl_receipt(path: &Path) -> Result<()> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                Err(error).with_context(|| format!("remove ACL lease {}", path.display()))
            }
        }
    }

    fn apply_acl_grant(path: &str, capability_sid: &str, grant: AclGrant) -> Result<()> {
        let access = match (grant, Path::new(path).is_dir()) {
            (AclGrant::ReadOnlyTree, true) => format!("*{capability_sid}:(OI)(CI)RX"),
            (AclGrant::ModifyTree, true) => format!("*{capability_sid}:(OI)(CI)M"),
            (AclGrant::ReadOnlyTree, false) => format!("*{capability_sid}:RX"),
            (AclGrant::ModifyTree, false) => format!("*{capability_sid}:M"),
        };
        run_icacls(
            path,
            &["/grant:r", &access, "/Q"],
            "grant AppContainer access to",
        )
    }

    fn rebuild_acl_state(state: &AclState) -> Result<()> {
        let mut snapshots = state.snapshots.iter().collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| Path::new(&snapshot.path).components().count());
        let mut leases = state.leases.iter().collect::<Vec<_>>();
        leases.sort_by(|left, right| left.lease_id.cmp(&right.lease_id));

        for snapshot in snapshots {
            restore_acl_snapshot(snapshot)?;
            let grants = leases
                .iter()
                .flat_map(|lease| {
                    lease
                        .grants
                        .iter()
                        .filter(|grant| paths_equal(&grant.path, Path::new(&snapshot.path)))
                        .map(move |grant| (*lease, grant))
                })
                .collect::<Vec<_>>();
            if grants.iter().any(|(_, grant)| grant.protected_boundary) {
                run_icacls(
                    &snapshot.path,
                    &["/inheritancelevel:d", "/Q"],
                    "isolate protected ACL inheritance on",
                )?;
                for (lease, _) in grants.iter().filter(|(_, grant)| grant.protected_boundary) {
                    let principal = format!("*{}", lease.capability_sid);
                    run_icacls(
                        &snapshot.path,
                        &["/remove:g", &principal, "/Q"],
                        "remove inherited AppContainer access from",
                    )?;
                }
            }
            for (lease, grant) in grants {
                apply_acl_grant(&snapshot.path, &lease.capability_sid, grant.access)?;
            }
        }
        Ok(())
    }

    fn prune_acl_snapshots(state: &mut AclState) {
        let active_paths = state
            .leases
            .iter()
            .flat_map(|lease| lease.grants.iter())
            .map(|grant| grant.path.to_lowercase())
            .collect::<BTreeSet<_>>();
        state
            .snapshots
            .retain(|snapshot| active_paths.contains(&snapshot.path.to_lowercase()));
    }

    fn release_acl_lease_locked(
        installation_id: &str,
        ownership_root: &Path,
        lease_id: &str,
    ) -> Result<()> {
        let Some(mut state) = read_acl_state(installation_id, ownership_root)? else {
            let receipt = acl_directory(ownership_root).join(format!("{lease_id}.json"));
            if receipt.exists() {
                bail!("ACL state is missing; preserving the lease receipt and filesystem ACLs");
            }
            return Ok(());
        };
        state.leases.retain(|lease| lease.lease_id != lease_id);
        write_acl_state(ownership_root, &state)?;
        rebuild_acl_state(&state)?;
        remove_acl_receipt(&acl_directory(ownership_root).join(format!("{lease_id}.json")))?;
        prune_acl_snapshots(&mut state);
        write_acl_state(ownership_root, &state)
    }

    fn recover_acl_leases(
        installation_id: &str,
        ownership_root: &Path,
        include_running: bool,
    ) -> Result<()> {
        let directory = acl_directory(ownership_root);
        let mut receipts = BTreeMap::new();
        match fs::read_dir(&directory) {
            Ok(entries) => {
                for entry in entries {
                    let path = entry?.path();
                    if path.extension().and_then(|value| value.to_str()) != Some("json") {
                        continue;
                    }
                    let record: AclLeaseRecord = serde_json::from_slice(
                        &fs::read(&path)
                            .with_context(|| format!("read ACL lease {}", path.display()))?,
                    )
                    .with_context(|| format!("parse ACL lease {}", path.display()))?;
                    validate_acl_record(&path, &record, installation_id)?;
                    receipts.insert(record.lease_id.clone(), (path, record));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("read ACL lease directory"),
        }

        let Some(mut state) = read_acl_state(installation_id, ownership_root)? else {
            if receipts.is_empty() {
                return Ok(());
            }
            bail!("ACL state is missing; preserving lease receipts and filesystem ACLs");
        };
        let mut retained = Vec::new();
        for lease in state.leases.drain(..) {
            let Some((_, receipt)) = receipts.get(&lease.lease_id) else {
                continue;
            };
            if receipt != &lease {
                bail!("ACL state and lease receipt disagree; preserving filesystem ACLs");
            }
            if !include_running && process_is_running(lease.owner_process_id) {
                retained.push(lease);
            }
        }
        state.leases = retained;
        write_acl_state(ownership_root, &state)?;
        rebuild_acl_state(&state)?;
        for (lease_id, (path, _)) in receipts {
            if !state.leases.iter().any(|lease| lease.lease_id == lease_id) {
                remove_acl_receipt(&path)?;
            }
        }
        prune_acl_snapshots(&mut state);
        write_acl_state(ownership_root, &state)?;
        Ok(())
    }

    impl AclLease {
        fn acquire(
            installation_id: &str,
            ownership_root: &Path,
            lease_id: String,
            capability: &CommandCapability,
            spec: &LaunchSpec,
        ) -> Result<Self> {
            validate_denied_roots(spec)?;
            let mut grants = BTreeMap::new();
            for path in &spec.read_only_roots {
                if !appcontainer_reads_without_capability(path) {
                    grants.insert(path.clone(), AclGrant::ReadOnlyTree);
                }
            }
            grants.extend(plan_writable_acl_grants(spec)?);
            let mut grants = grants.into_iter().collect::<Vec<_>>();
            grants.sort_by_key(|(path, _)| Path::new(path).components().count());
            let path = acl_directory(ownership_root).join(format!("{lease_id}.json"));
            let record = AclLeaseRecord {
                schema_version: ACL_LEASE_SCHEMA,
                installation_id: installation_id.to_owned(),
                lease_id,
                owner_process_id: unsafe { GetCurrentProcessId() },
                capability_name: capability.name().to_owned(),
                capability_sid: sid_text(capability.sid())?,
                grants: grants
                    .into_iter()
                    .map(|(path, access)| AclLeaseGrant {
                        protected_boundary: is_protected_write_boundary(spec, &path),
                        path,
                        access,
                    })
                    .collect(),
            };
            let mut state = read_acl_state(installation_id, ownership_root)?.unwrap_or(AclState {
                schema_version: ACL_STATE_SCHEMA,
                installation_id: installation_id.to_owned(),
                snapshots: Vec::new(),
                leases: Vec::new(),
            });
            for grant in &record.grants {
                if !state
                    .snapshots
                    .iter()
                    .any(|snapshot| paths_equal(&snapshot.path, Path::new(&grant.path)))
                {
                    state.snapshots.push(capture_acl_snapshot(&grant.path)?);
                }
            }
            state.leases.push(record.clone());
            state
                .leases
                .sort_by(|left, right| left.lease_id.cmp(&right.lease_id));
            write_acl_state(ownership_root, &state)?;
            if let Err(error) =
                write_acl_record(&path, &record).and_then(|()| rebuild_acl_state(&state))
            {
                state
                    .leases
                    .retain(|lease| lease.lease_id != record.lease_id);
                let rollback = write_acl_state(ownership_root, &state)
                    .and_then(|()| rebuild_acl_state(&state))
                    .and_then(|()| remove_acl_receipt(&path))
                    .and_then(|()| {
                        prune_acl_snapshots(&mut state);
                        write_acl_state(ownership_root, &state)
                    });
                return match rollback {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(error.context(format!(
                        "rollback command filesystem ACLs also failed: {rollback_error:#}"
                    ))),
                };
            }
            Ok(Self {
                installation_id: installation_id.to_owned(),
                ownership_root: ownership_root.to_owned(),
                record,
                released: false,
            })
        }

        fn release(&mut self) -> Result<()> {
            if self.released {
                return Ok(());
            }
            let _lock = OperationLock::acquire(&self.installation_id)?;
            release_acl_lease_locked(
                &self.installation_id,
                &self.ownership_root,
                &self.record.lease_id,
            )?;
            self.released = true;
            Ok(())
        }
    }

    impl Drop for AclLease {
        fn drop(&mut self) {
            let _ = self.release();
        }
    }

    struct AttributeList {
        storage: Vec<usize>,
    }

    impl AttributeList {
        fn new(capabilities: &SECURITY_CAPABILITIES) -> Result<Self> {
            let mut bytes = 0usize;
            let _ = unsafe { InitializeProcThreadAttributeList(None, 1, Some(0), &mut bytes) };
            if bytes == 0 {
                bail!("Windows did not report a process attribute list size");
            }
            let mut result = Self {
                storage: vec![0usize; bytes.div_ceil(size_of::<usize>())],
            };
            let pointer = result.pointer();
            unsafe { InitializeProcThreadAttributeList(Some(pointer), 1, Some(0), &mut bytes) }
                .context("initialize process attributes")?;
            unsafe {
                UpdateProcThreadAttribute(
                    pointer,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    Some((capabilities as *const SECURITY_CAPABILITIES).cast()),
                    size_of::<SECURITY_CAPABILITIES>(),
                    None,
                    None,
                )
            }
            .context("set AppContainer process attribute")?;
            Ok(result)
        }

        fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
            LPPROC_THREAD_ATTRIBUTE_LIST(self.storage.as_mut_ptr().cast())
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.pointer()) };
        }
    }

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    struct TerminateOnDrop {
        process: HANDLE,
        armed: bool,
    }

    impl Drop for TerminateOnDrop {
        fn drop(&mut self) {
            if self.armed {
                unsafe {
                    let _ = TerminateProcess(self.process, 1);
                }
            }
        }
    }

    fn launch_child(
        spec: &LaunchSpec,
        app_container_sid: PSID,
        capability: &mut CommandCapability,
        operation_lock: OperationLock,
    ) -> Result<u32> {
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: app_container_sid,
            Capabilities: capability.entries.as_mut_ptr(),
            CapabilityCount: capability.entries.len() as u32,
            Reserved: 0,
        };
        let mut attributes = AttributeList::new(&capabilities)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = HANDLE(std::io::stdin().as_raw_handle());
        startup.StartupInfo.hStdOutput = HANDLE(std::io::stdout().as_raw_handle());
        startup.StartupInfo.hStdError = HANDLE(std::io::stderr().as_raw_handle());
        startup.lpAttributeList = attributes.pointer();

        let mut mutable_command = wide(&command_line(spec));
        let current_directory = wide(&spec.cwd);
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        unsafe {
            CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(mutable_command.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                None,
                PCWSTR(current_directory.as_ptr()),
                (&startup as *const STARTUPINFOEXW).cast(),
                &mut process_info,
            )
        }
        .context("create AppContainer process")?;
        let process = Handle(process_info.hProcess);
        let thread = Handle(process_info.hThread);
        let mut terminate = TerminateOnDrop {
            process: process.0,
            armed: true,
        };
        let capability_enabled = process_has_enabled_capability(process.0, capability.sid());
        match capability_enabled {
            Ok(true) => {}
            Ok(false) => {
                unsafe { TerminateProcess(process.0, 1) }
                    .context("terminate process missing command filesystem capability")?;
                bail!("created process token did not enable command filesystem capability");
            }
            Err(error) => {
                let _ = unsafe { TerminateProcess(process.0, 1) };
                return Err(error.context("verify command filesystem capability"));
            }
        }

        let job = Handle(
            unsafe { CreateJobObjectW(None, PCWSTR::null()) }.context("create process job")?,
        );
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .context("configure process job")?;
        unsafe { AssignProcessToJobObject(job.0, process.0) }.context("assign process job")?;
        if unsafe { ResumeThread(thread.0) } == u32::MAX {
            bail!("resume AppContainer process");
        }
        terminate.armed = false;
        drop(operation_lock);
        unsafe { WaitForSingleObject(process.0, INFINITE) };
        let mut exit_code = 1u32;
        unsafe { GetExitCodeProcess(process.0, &mut exit_code) }
            .context("read process exit code")?;
        Ok(exit_code)
    }

    pub fn launch(installation_id: &str, requested_root: &str, spec: LaunchSpec) -> Result<u32> {
        let operation_lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        recover_acl_leases(installation_id, &ownership_root, false)?;
        let Some(record) = ownership_record(installation_id, &ownership_root)? else {
            bail!("Notebook AppContainer is not owned by this installation");
        };
        let sid = profile_sid(&record.profile_name)?;
        if record.state != OwnershipState::Owned {
            bail!("Notebook AppContainer setup is incomplete");
        }
        if !profile_exists(sid.0)? || !loopback_contains(sid.0)? {
            bail!("Notebook AppContainer setup is incomplete");
        }
        let lease_id = new_lease_id()?;
        let capability_name = command_capability_name(installation_id, &lease_id);
        let mut capability = CommandCapability::new(capability_name)?;
        let mut lease = AclLease::acquire(
            installation_id,
            &ownership_root,
            lease_id,
            &capability,
            &spec,
        )?;
        let result = launch_child(&spec, sid.0, &mut capability, operation_lock);
        let release = lease.release();
        match (result, release) {
            (Ok(code), Ok(())) => Ok(code),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error.context("release command filesystem ACLs")),
            (Err(error), Err(release_error)) => Err(error.context(format!(
                "release command filesystem ACLs also failed: {release_error:#}"
            ))),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn unique_test_root(label: &str) -> PathBuf {
            std::env::temp_dir().join(format!(
                "open-science-{label}-{}-{:?}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
        }

        #[test]
        fn prepare_setup_does_not_create_profile_before_elevation() {
            let installation_id = "fedcba9876543210fedcba98";
            let parent = unique_test_root("prepare-setup");
            let root = parent.join(installation_id);
            let path = root.to_string_lossy().into_owned();

            prepare_setup(installation_id, &path).unwrap();
            let creating = read_record(&journal_path(&root)).unwrap().unwrap();
            let sid = profile_sid(&creating.profile_name).unwrap();
            let exists = profile_exists(sid.0).unwrap();
            cancel_setup(installation_id, &path).unwrap();
            fs::remove_dir_all(&parent).unwrap();

            assert!(!exists);
        }

        #[test]
        fn acl_snapshot_restore_preserves_inheritance_control() {
            let root = unique_test_root("acl-restore");
            fs::create_dir_all(&root).unwrap();
            let path = root.to_string_lossy().into_owned();
            let original = capture_acl_snapshot(&path).unwrap();

            run_icacls(
                &path,
                &["/grant:r", "*S-1-1-0:(OI)(CI)RX", "/Q"],
                "modify test ACL on",
            )
            .unwrap();
            restore_acl_snapshot(&original).unwrap();
            let restored = capture_acl_snapshot(&path).unwrap();
            fs::remove_dir_all(&root).unwrap();

            assert_eq!(restored, original);
        }

        #[test]
        fn acl_snapshot_restore_skips_only_unchanged_acl() {
            let snapshot = AclSnapshot {
                path: r"C:\Program Files\GitHub CLI".to_owned(),
                dacl_sddl: "D:".to_owned(),
                dacl_protected: false,
                dacl_auto_inherited: true,
                dacl_auto_inherit_requested: false,
            };
            let mut restore_called = false;

            restore_acl_snapshot_if_needed(&snapshot, &snapshot, || {
                restore_called = true;
                Ok(())
            })
            .unwrap();

            assert!(!restore_called);

            let changed = AclSnapshot {
                dacl_sddl: "D:(A;;GA;;;WD)".to_owned(),
                ..snapshot.clone()
            };
            restore_acl_snapshot_if_needed(&snapshot, &changed, || {
                restore_called = true;
                Ok(())
            })
            .unwrap();

            assert!(restore_called);
        }
    }
}

#[cfg(windows)]
fn probe_filesystem(
    system_file: &str,
    read_only_file: &str,
    read_write_file: &str,
    denied_file: &str,
) -> Result<()> {
    std::fs::metadata(system_file).context("probe required Windows system file")?;
    let contents = std::fs::read_to_string(read_only_file).context("probe read-only file read")?;
    if contents.trim() != "readable" {
        bail!("probe read-only file had unexpected contents");
    }
    if std::fs::write(read_only_file, b"changed").is_ok() {
        bail!("probe wrote to a read-only file");
    }
    if std::fs::read(denied_file).is_ok() {
        bail!("probe read a denied file");
    }
    std::fs::write(read_write_file, b"allowed").context("probe read-write file write")?;
    Ok(())
}

#[cfg(windows)]
fn probe_protected_workspace(
    workspace: &str,
    writable_file: &str,
    protected_file: &str,
    protected_directory: &str,
) -> Result<()> {
    std::fs::write(writable_file, b"updated").context("probe existing workspace file write")?;

    let created_file = Path::new(workspace).join("created-by-sandbox.txt");
    std::fs::write(&created_file, b"created").context("probe workspace file create")?;
    let created_contents =
        std::fs::read_to_string(&created_file).context("probe created workspace file reopen")?;
    if created_contents != "created" {
        bail!("probe created workspace file had unexpected contents");
    }
    let created_directory = Path::new(workspace).join("created-directory");
    std::fs::create_dir(&created_directory).context("probe workspace directory create")?;
    let nested_file = created_directory.join("nested.txt");
    std::fs::write(&nested_file, b"nested").context("probe nested workspace file create")?;
    if std::fs::read_to_string(&nested_file).context("probe nested workspace file reopen")?
        != "nested"
    {
        bail!("probe nested workspace file had unexpected contents");
    }

    std::fs::read(protected_file).context("probe protected workspace file read")?;
    if std::fs::write(protected_file, b"changed").is_ok() {
        bail!("probe wrote to a protected workspace file");
    }
    if std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(protected_file)
        .is_ok()
    {
        bail!("probe truncated a protected workspace file");
    }
    if std::fs::remove_file(protected_file).is_ok() {
        bail!("probe deleted a protected workspace file");
    }

    let protected_entry = Path::new(protected_directory).join("existing-hook");
    std::fs::read(&protected_entry).context("probe protected workspace directory read")?;
    if std::fs::write(
        Path::new(protected_directory).join("created-hook"),
        b"created",
    )
    .is_ok()
    {
        bail!("probe created a file in a protected workspace directory");
    }
    if std::fs::remove_file(&protected_entry).is_ok() {
        bail!("probe deleted a file in a protected workspace directory");
    }
    Ok(())
}

#[cfg(windows)]
fn run() -> Result<i32> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("probe-filesystem") => {
            let system_file = args.next().context("missing system file")?;
            let read_only_file = args.next().context("missing read-only file")?;
            let read_write_file = args.next().context("missing read-write file")?;
            let denied_file = args.next().context("missing denied file")?;
            if args.next().is_some() {
                bail!("unexpected filesystem probe argument");
            }
            probe_filesystem(
                &system_file,
                &read_only_file,
                &read_write_file,
                &denied_file,
            )?;
            Ok(0)
        }
        Some("probe-protected-workspace") => {
            let workspace = args.next().context("missing workspace")?;
            let writable_file = args.next().context("missing writable file")?;
            let protected_file = args.next().context("missing protected file")?;
            let protected_directory = args.next().context("missing protected directory")?;
            if args.next().is_some() {
                bail!("unexpected protected workspace probe argument");
            }
            probe_protected_workspace(
                &workspace,
                &writable_file,
                &protected_file,
                &protected_directory,
            )?;
            Ok(0)
        }
        Some("status") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected status argument");
            }
            windows_host::status(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("prepare-setup") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected prepare-setup argument");
            }
            windows_host::prepare_setup(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("cancel-setup") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected cancel-setup argument");
            }
            windows_host::cancel_setup(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("setup") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected setup argument");
            }
            windows_host::setup_network(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("finish-setup") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected finish-setup argument");
            }
            windows_host::finish_setup(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("prepare-remove") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected prepare-remove argument");
            }
            windows_host::prepare_remove(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("remove") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected remove argument");
            }
            windows_host::remove_network(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("finish-remove") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            if args.next().is_some() {
                bail!("unexpected finish-remove argument");
            }
            windows_host::finish_remove(&installation_id, &ownership_root)?;
            Ok(0)
        }
        Some("launch") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            let encoded = args.next().context("missing launch specification")?;
            if args.next().is_some() {
                bail!("unexpected launch argument");
            }
            Ok(windows_host::launch(
                &installation_id,
                &ownership_root,
                decode_launch_spec(&encoded)?,
            )? as i32)
        }
        _ => bail!(
            "usage: notebook-appcontainer-host <status|prepare-setup|cancel-setup|setup|finish-setup|prepare-remove|remove|finish-remove INSTALLATION_ID OWNERSHIP_ROOT|launch INSTALLATION_ID OWNERSHIP_ROOT SPEC>"
        ),
    }
}

#[cfg(not(windows))]
fn run() -> Result<i32> {
    bail!("notebook-appcontainer-host is only available on Windows")
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error:#}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_command_line_preserves_spaces_quotes_and_trailing_slashes() {
        let spec = LaunchSpec {
            executable: "C:\\Program Files\\PowerShell\\pwsh.exe".into(),
            arguments: vec!["-Command".into(), "Write-Output \"hello\"\\".into()],
            cwd: "C:\\workspace".into(),
            read_only_roots: Vec::new(),
            read_write_roots: Vec::new(),
            denied_read_roots: Vec::new(),
            denied_write_roots: Vec::new(),
        };
        assert_eq!(
            command_line(&spec),
            "\"C:\\Program Files\\PowerShell\\pwsh.exe\" -Command \"Write-Output \\\"hello\\\"\\\\\""
        );
    }

    #[test]
    fn launch_spec_uses_camel_case_fields() {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            br#"{"executable":"cmd.exe","arguments":[],"cwd":"C:\\w","readOnlyRoots":[],"readWriteRoots":[],"deniedReadRoots":[],"deniedWriteRoots":[]}"#,
        );
        let decoded = decode_launch_spec(&encoded).unwrap();
        assert_eq!(decoded.executable, "cmd.exe");
    }

    #[test]
    fn ownership_json_accepts_windows_powershell_utf8_bom() {
        let json = b"\xef\xbb\xbf{\"state\":\"creating\"}";
        let value: serde_json::Value = serde_json::from_slice(strip_utf8_bom(json)).unwrap();
        assert_eq!(value["state"], "creating");
    }

    #[test]
    fn command_capability_names_bind_the_installation_and_lease() {
        let installation_id = "0123456789abcdef01234567";
        let lease_id = "01234567-89ab-cdef-0123-456789abcdef";
        assert!(valid_lease_id(lease_id));
        assert_eq!(
            command_capability_name(installation_id, lease_id),
            "open-science.notebook.0123456789abcdef01234567.01234567-89ab-cdef-0123-456789abcdef"
        );
        assert!(!valid_lease_id("../../receipt"));
        assert!(!valid_lease_id("01234567-89ab-cdef-0123-456789abcdeg"));
    }

    #[test]
    fn writable_acl_projection_stops_at_protected_descendants() {
        let root = std::env::temp_dir().join(format!(
            "open-science-acl-plan-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = root.join("workspace");
        let source = workspace.join("src");
        let git = workspace.join(".git");
        let config = git.join("config");
        let hooks = git.join("hooks");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(&config, b"[core]\n").unwrap();
        let spec = LaunchSpec {
            executable: "cmd.exe".into(),
            arguments: Vec::new(),
            cwd: workspace.to_string_lossy().into_owned(),
            read_only_roots: Vec::new(),
            read_write_roots: vec![workspace.to_string_lossy().into_owned()],
            denied_read_roots: Vec::new(),
            denied_write_roots: vec![git.to_string_lossy().into_owned()],
        };

        let grants = plan_writable_acl_grants(&spec).unwrap();

        assert_eq!(grants.get(&spec.cwd), Some(&AclGrant::ModifyTree));
        assert!(!grants.contains_key(&source.to_string_lossy().into_owned()));
        assert_eq!(
            grants.get(&git.to_string_lossy().into_owned()),
            Some(&AclGrant::ReadOnlyTree)
        );
        assert!(!grants.contains_key(&config.to_string_lossy().into_owned()));
        assert!(!grants.contains_key(&hooks.to_string_lossy().into_owned()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
