use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use base64::Engine;
use serde::{Deserialize, Serialize};

#[cfg(windows)]
mod wfp;

#[cfg(windows)]
mod directory_access;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchSpec {
    executable: String,
    arguments: Vec<String>,
    #[serde(default)]
    verbatim_arguments: bool,
    cwd: String,
    read_only_roots: Vec<String>,
    read_write_roots: Vec<String>,
    denied_read_roots: Vec<String>,
    denied_write_roots: Vec<String>,
    termination_proof_path: Option<String>,
    termination_proof_token: Option<String>,
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
    if spec.verbatim_arguments {
        return std::iter::once(quote_windows_argument(&spec.executable))
            .chain(spec.arguments.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");
    }
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
    use std::io::{Read, Write};
    use std::mem::{size_of, zeroed};
    use std::net::TcpListener;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result, bail};
    use serde::{Deserialize, Serialize};
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_PIPE_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
        HANDLE_FLAG_INHERIT, HLOCAL, LocalFree, SetHandleInformation, WAIT_ABANDONED,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::NetworkManagement::WindowsFirewall::{
        NetworkIsolationGetAppContainerConfig, NetworkIsolationSetAppContainerConfig,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertSidToStringSidW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
        GetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
    };
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
    };
    use windows::Win32::Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION_DS, ACL_SIZE_INFORMATION,
        AclSizeInformation, AddAccessAllowedAceEx, AddAce, DACL_SECURITY_INFORMATION,
        DeriveCapabilitySidsFromName, EqualSid, FreeSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
        INHERITED_ACE, InitializeAcl, InitializeSecurityDescriptor, OBJECT_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SE_DACL_AUTO_INHERIT_REQ,
        SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
        SECURITY_DESCRIPTOR, SECURITY_DESCRIPTOR_CONTROL, SID_AND_ATTRIBUTES, SetFileSecurityW,
        SetSecurityDescriptorControl, SetSecurityDescriptorDacl, TOKEN_APPCONTAINER_INFORMATION,
        TOKEN_GROUPS, TOKEN_QUERY, TOKEN_USER, TokenAppContainerSid, TokenCapabilities, TokenUser,
        UNPROTECTED_DACL_SECURITY_INFORMATION,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_MODE,
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX,
    };
    use windows::Win32::System::Com::{CoCreateGuid, CoTaskMemFree};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows::Win32::System::Memory::{GetProcessHeap, HEAP_FLAGS, HeapFree};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, PIPE_NOWAIT,
        PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PeekNamedPipe,
    };
    use windows::Win32::System::SystemServices::{SE_GROUP_ENABLED, SECURITY_DESCRIPTOR_REVISION};
    use windows::Win32::System::Threading::{
        CREATE_SUSPENDED, CreateMutexW, CreateProcessW, DeleteProcThreadAttributeList,
        EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcessId, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcess,
        OpenProcessToken, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_ACCESS_RIGHTS,
        PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, ReleaseMutex,
        ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject,
    };
    use windows::core::{BOOL, PCWSTR, PWSTR};

    use super::{
        AclGrant, LaunchSpec, command_capability_name, command_line, path_is_within, paths_equal,
        plan_writable_acl_grants, strip_utf8_bom, valid_lease_id, wfp,
    };

    const PROFILE_PREFIX: &str = "Aipoch.OpenScience.Notebook";
    const PROCESS_SYNCHRONIZE: PROCESS_ACCESS_RIGHTS = PROCESS_ACCESS_RIGHTS(0x0010_0000);
    const RECEIPT_SCHEMA: u32 = 5;
    const VERIFIED_JOURNAL_SCHEMA: u32 = 6;
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
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        runtime_directory_access: Vec<RuntimeDirectoryAccess>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pending_runtime_access: Option<PendingRuntimeAccess>,
    }

    #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct PendingRuntimeAccess {
        executable: String,
        // Identifies only the verification process's existing ACL lease; not a pipe credential.
        lease_id: String,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct RuntimeDirectoryAccess {
        executable: String,
        selected_executable: String,
        directories: Vec<String>,
    }

    fn runtime_path_matches(executable: &str, entry: &RuntimeDirectoryAccess) -> bool {
        paths_equal(executable, Path::new(&entry.selected_executable))
            || paths_equal(executable, Path::new(&entry.executable))
    }

    fn runtime_directories(record: &OwnershipRecord) -> BTreeSet<String> {
        record
            .runtime_directory_access
            .iter()
            .flat_map(|entry| entry.directories.iter().cloned())
            .collect()
    }

    fn r_installation_directories(executable: &Path) -> Result<Vec<String>> {
        if !executable.is_absolute()
            || !executable
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("Rscript.exe"))
        {
            bail!("Select an absolute Rscript.exe path");
        }
        let directory = executable
            .parent()
            .context("Rscript has no parent directory")?;
        let bin = if directory
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("x64"))
        {
            directory.parent().context("Rscript has no bin directory")?
        } else {
            directory
        };
        if !bin
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("bin"))
        {
            bail!("Rscript is not in an R installation bin directory");
        }
        let home = bin.parent().context("R installation has no home")?;
        let mut directories = home
            .ancestors()
            .skip(1)
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        directories.reverse();
        Ok(directories)
    }

    fn validate_runtime_directory_access(record: &OwnershipRecord) -> Result<()> {
        let mut paths = BTreeSet::new();
        for entry in &record.runtime_directory_access {
            if !Path::new(&entry.selected_executable).is_absolute()
                || !paths.insert(entry.executable.to_lowercase())
                || entry.directories != r_installation_directories(Path::new(&entry.executable))?
            {
                bail!("Runtime directory ownership does not match its selected interpreter");
            }
        }
        Ok(())
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

    fn runtime_access_guard(installation_id: &str) -> Result<OperationLock> {
        let name = wide(&format!("{OPERATION_MUTEX}.RAccess.{installation_id}"));
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .context("open R authorization lifetime guard")?;
        let acquired = unsafe { WaitForSingleObject(handle, 0) };
        if acquired == WAIT_OBJECT_0 || acquired == WAIT_ABANDONED {
            return Ok(OperationLock(handle));
        }
        unsafe { CloseHandle(handle) }.ok();
        bail!("R authorization is still active; wait before changing protected-mode resources");
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
        if ![4, RECEIPT_SCHEMA, VERIFIED_JOURNAL_SCHEMA].contains(&record.schema_version)
            || record.installation_id != installation_id
            || record.profile_name != expected_name
            || record.profile_sid != expected_sid
            || record.ownership_token.is_empty()
            || record.gateway_port == 0
            || wfp::validate_keys(&descriptor).is_err()
        {
            bail!("AppContainer ownership record does not match this installation");
        }
        validate_runtime_directory_access(record)?;
        match &record.pending_runtime_access {
            Some(pending)
                if record.schema_version == VERIFIED_JOURNAL_SCHEMA
                    && record.state == OwnershipState::Creating
                    && valid_lease_id(&pending.lease_id)
                    && record
                        .runtime_directory_access
                        .iter()
                        .any(|entry| entry.executable == pending.executable) => {}
            None if record.schema_version != VERIFIED_JOURNAL_SCHEMA => {}
            _ => bail!("Invalid pending R verification journal; preserving resources"),
        }
        if record.schema_version == 4 && !record.runtime_directory_access.is_empty() {
            bail!("Legacy ownership cannot contain runtime directory grants");
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
        unsafe {
            MoveFileExW(
                PCWSTR(wide(&temporary.to_string_lossy()).as_ptr()),
                PCWSTR(wide(&receipt.to_string_lossy()).as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .context("commit AppContainer ownership receipt")
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
        let _transaction = runtime_access_guard(installation_id)?;
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
                schema_version: 4,
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
                runtime_directory_access: Vec::new(),
                pending_runtime_access: None,
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

    pub fn prepare_runtime_access(
        installation_id: &str,
        requested_root: &str,
        executable: &str,
        remove: bool,
        verified: bool,
    ) -> Result<()> {
        let _transaction = runtime_access_guard(installation_id)?;
        let _lock = OperationLock::acquire(installation_id)?;
        let root = ownership_directory(installation_id, requested_root)?;
        if journal_path(&root).exists() {
            bail!("Complete the pending protected-mode repair before changing runtime permissions");
        }
        let previous = ownership_record(installation_id, &root)?
            .context("Enable protected mode before authorizing an R runtime")?;
        if previous.state != OwnershipState::Owned {
            bail!("Protected-mode setup is incomplete");
        }
        let mut record = previous.clone();
        if remove {
            record
                .runtime_directory_access
                .retain(|entry| !runtime_path_matches(executable, entry));
        } else {
            if !Path::new(executable).is_absolute() {
                bail!("Select an absolute R interpreter path");
            }
            let selected_executable = executable.to_owned();
            let canonical =
                fs::canonicalize(executable).context("resolve selected R interpreter")?;
            let canonical = canonical.to_string_lossy();
            let executable = canonical
                .strip_prefix(r"\\?\")
                .unwrap_or(&canonical)
                .to_owned();
            let path = Path::new(&executable);
            if !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix)) if matches!(prefix.kind(), std::path::Prefix::Disk(_)))
            {
                bail!("R runtime authorization requires a local drive path");
            }
            let directories = r_installation_directories(path)?;
            let bin = path.parent().context("Rscript parent is missing")?;
            let home = if bin
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("x64"))
            {
                bin.parent().and_then(Path::parent)
            } else {
                bin.parent()
            }
            .context("R installation home is missing")?;
            if !home.join("etc").is_dir() || !home.join("library").is_dir() {
                bail!("Selected R installation is incomplete");
            }
            record
                .runtime_directory_access
                .retain(|entry| !paths_equal(&executable, Path::new(&entry.executable)));
            record
                .runtime_directory_access
                .push(RuntimeDirectoryAccess {
                    executable,
                    selected_executable,
                    directories,
                });
            for directory in
                runtime_directories(&record).difference(&runtime_directories(&previous))
            {
                if super::directory_access::is_granted(directory, &record.profile_sid)? {
                    bail!("Unowned directory permission exists; preserving {directory}");
                }
            }
        }
        record.schema_version = if record.runtime_directory_access.is_empty() {
            4
        } else {
            RECEIPT_SCHEMA
        };
        record.state = OwnershipState::Creating;
        if verified {
            if remove {
                bail!("Removal cannot prepare R verification");
            }
            record.schema_version = VERIFIED_JOURNAL_SCHEMA;
            record.pending_runtime_access = Some(PendingRuntimeAccess {
                executable: record
                    .runtime_directory_access
                    .last()
                    .context("R access is missing")?
                    .executable
                    .clone(),
                lease_id: new_lease_id()?,
            });
        }
        replace_journal(&root, &record)
    }

    pub fn runtime_access_status(
        installation_id: &str,
        requested_root: &str,
        executable: &str,
    ) -> Result<()> {
        let _lock = OperationLock::acquire(installation_id)?;
        let root = ownership_directory(installation_id, requested_root)?;
        if journal_path(&root).exists() {
            bail!(
                "Complete the pending protected-mode operation before changing runtime permissions"
            );
        }
        let mut authorized = false;
        let mut registered = false;
        if let Some(record) = ownership_record(installation_id, &root)? {
            if record.state == OwnershipState::Owned {
                if let Some(entry) = record
                    .runtime_directory_access
                    .iter()
                    .find(|entry| runtime_path_matches(executable, entry))
                {
                    registered = true;
                    authorized = true;
                    for path in &entry.directories {
                        if !Path::new(path).is_dir()
                            || !super::directory_access::is_granted(path, &record.profile_sid)?
                        {
                            authorized = false;
                            break;
                        }
                    }
                }
            }
        }
        println!(
            "{}",
            serde_json::json!({ "authorized": authorized, "registered": registered })
        );
        Ok(())
    }

    fn reconcile_runtime_directories(
        record: &OwnershipRecord,
        previous: Option<&OwnershipRecord>,
    ) -> Result<()> {
        let desired = runtime_directories(record);
        let previous = previous.map(runtime_directories).unwrap_or_default();
        for directory in &desired {
            super::directory_access::update(directory, &record.profile_sid, true, true)?;
        }
        for directory in previous.difference(&desired) {
            if Path::new(directory).exists() {
                super::directory_access::update(directory, &record.profile_sid, false, true)?;
            }
        }
        Ok(())
    }

    fn rollback_runtime_directories(
        record: &OwnershipRecord,
        previous: Option<&OwnershipRecord>,
    ) -> Result<()> {
        let previous_directories = previous.map(runtime_directories).unwrap_or_default();
        for directory in runtime_directories(record).difference(&previous_directories) {
            if Path::new(directory).exists() {
                super::directory_access::update(directory, &record.profile_sid, false, true)?;
            }
        }
        for directory in previous_directories {
            super::directory_access::update(&directory, &record.profile_sid, true, true)?;
        }
        Ok(())
    }

    pub fn cancel_setup(installation_id: &str, requested_root: &str) -> Result<()> {
        let _transaction = runtime_access_guard(installation_id)?;
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
            for path in runtime_directories(&journal).difference(&runtime_directories(&receipt)) {
                if Path::new(path).exists()
                    && super::directory_access::is_granted(path, &journal.profile_sid)?
                {
                    bail!(
                        "Runtime directory setup is partially applied; complete repair before cancellation"
                    );
                }
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
        refresh_owned_runtime_acl_snapshots(installation_id, &ownership_root)?;
        fs::remove_file(journal_path(&ownership_root))
            .context("cancel AppContainer setup repair")?;
        Ok(())
    }

    fn rollback_verified_runtime_access(
        installation_id: &str,
        root: &Path,
        record: &OwnershipRecord,
        previous: Option<&OwnershipRecord>,
    ) -> Result<()> {
        let pending = record
            .pending_runtime_access
            .as_ref()
            .context("Missing R verification journal")?;
        if read_acl_state(installation_id, root)?.is_some_and(|state| {
            state.leases.iter().any(|lease| {
                lease.lease_id == pending.lease_id && process_is_running(lease.owner_process_id)
            })
        }) {
            bail!("Stop the owned R verification process before repairing its permissions");
        }
        recover_acl_leases(installation_id, root, false)?;
        rollback_runtime_directories(record, previous)?;
        refresh_owned_runtime_acl_snapshots(installation_id, root)?;
        fs::remove_file(journal_path(root)).context("remove rolled-back R verification journal")
    }

    fn verification_pipe_name(ticket: &str) -> Result<String> {
        if ticket.len() != 64 || !ticket.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            bail!("Invalid R verification pipe identity");
        }
        Ok(format!(r"\\.\pipe\LOCAL\OpenScience.RAccess.{ticket}"))
    }

    fn process_user_sid(process: HANDLE) -> Result<String> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .context("open verifier token")?;
        let token = Handle(token);
        let mut bytes = 0;
        let _ = unsafe { GetTokenInformation(token.0, TokenUser, None, 0, &mut bytes) };
        if bytes < size_of::<TOKEN_USER>() as u32 {
            bail!("Invalid verifier token size");
        }
        let mut storage = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(storage.as_mut_ptr().cast()),
                (storage.len() * size_of::<usize>()) as u32,
                &mut bytes,
            )
        }
        .context("read verifier user")?;
        sid_text(unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() }.User.Sid)
    }

    fn create_verification_pipe(ticket: &str, verifier: HANDLE) -> Result<fs::File> {
        let name = wide(&verification_pipe_name(ticket)?);
        // Do not inherit the default pipe ACL (which includes Everyone). The intended user can
        // connect even when UAC was answered with a different administrator account.
        let sddl = wide(&format!(
            "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{})",
            process_user_sid(verifier)?
        ));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .context("create verifier pipe security")?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                256,
                256,
                0,
                Some(&attributes),
            )
        };
        unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
        if pipe.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(unsafe { fs::File::from_raw_handle(pipe.0) })
    }

    fn pipe_handle(pipe: &fs::File) -> HANDLE {
        HANDLE(pipe.as_raw_handle())
    }

    fn read_verification_message(
        pipe: &mut fs::File,
        mut alive: impl FnMut() -> bool,
    ) -> Result<String> {
        let started = Instant::now();
        let mut message = Vec::new();
        loop {
            if !alive() || started.elapsed() > Duration::from_secs(45) {
                bail!("R verification peer exited or timed out");
            }
            let mut available = 0;
            unsafe { PeekNamedPipe(pipe_handle(pipe), None, 0, None, Some(&mut available), None) }
                .context("read R verification connection")?;
            if available > 0 {
                let mut byte = [0];
                pipe.read_exact(&mut byte)
                    .context("read R verification result")?;
                if byte[0] == b'\n' {
                    return String::from_utf8(message).context("invalid verification response");
                }
                message.push(byte[0]);
                if message.len() > 16 {
                    bail!("Oversized R verification response");
                }
            } else {
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    }

    fn process_alive(process: HANDLE) -> bool {
        unsafe { WaitForSingleObject(process, 0) == WAIT_TIMEOUT }
    }

    pub fn authorize_runtime_access(
        installation_id: &str,
        requested_root: &str,
        ticket: &str,
        verifier_pid: u32,
        owner_pid: u32,
    ) -> Result<()> {
        let _transaction = runtime_access_guard(installation_id)?;
        let verifier = Handle(
            unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                    false,
                    verifier_pid,
                )
            }
            .context("open exact R verifier process")?,
        );
        let owner = Handle(
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, owner_pid) }
                .context("open R authorization owner")?,
        );
        let mut pipe = create_verification_pipe(ticket, verifier.0)?;
        let started = Instant::now();
        loop {
            let connected = unsafe { ConnectNamedPipe(pipe_handle(&pipe), None) };
            if connected.is_ok()
                || connected
                    .as_ref()
                    .is_err_and(|e| e.code() == ERROR_PIPE_CONNECTED.to_hresult())
            {
                break;
            }
            if !process_alive(verifier.0)
                || !process_alive(owner.0)
                || started.elapsed() > Duration::from_secs(15)
            {
                bail!("R verifier did not connect");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let mut actual_pid = 0;
        unsafe { GetNamedPipeClientProcessId(pipe_handle(&pipe), &mut actual_pid) }
            .context("identify R verifier")?;
        if actual_pid != verifier_pid {
            bail!("Unexpected R verification client");
        }
        let lock = OperationLock::acquire(installation_id)?;
        let root = ownership_directory(installation_id, requested_root)?;
        let record =
            ownership_record(installation_id, &root)?.context("Missing R access journal")?;
        record
            .pending_runtime_access
            .as_ref()
            .context("R access was not prepared for verification")?;
        let previous =
            read_record(&receipt_path(&root))?.context("Missing previous owned receipt")?;
        validate_record(&previous, installation_id)?;
        let applied = reconcile_runtime_directories(&record, Some(&previous));
        drop(lock);
        let verified = applied.and_then(|()| {
            pipe.write_all(b"ready\n").context("notify R verifier")?;
            if read_verification_message(&mut pipe, || {
                process_alive(owner.0) && process_alive(verifier.0)
            })? != "commit"
            {
                bail!("R protocol verification failed; new access was rolled back");
            }
            Ok(())
        });
        complete_runtime_verification(
            installation_id,
            &root,
            record,
            &previous,
            verified,
            verifier.0,
            owner.0,
        )?;
        pipe.write_all(b"committed\n")
            .context("acknowledge verified R access")?;
        Ok(())
    }

    fn complete_runtime_verification(
        installation_id: &str,
        root: &Path,
        record: OwnershipRecord,
        previous: &OwnershipRecord,
        verified: Result<()>,
        verifier: HANDLE,
        owner: HANDLE,
    ) -> Result<()> {
        let pending = record
            .pending_runtime_access
            .as_ref()
            .context("Missing R verification journal")?;
        let _lock = OperationLock::acquire(installation_id)?;
        let current =
            ownership_record(installation_id, &root)?.context("R access journal disappeared")?;
        if current.pending_runtime_access.as_ref() != Some(pending) {
            bail!("R access transaction changed; preserving ownership records");
        }
        let verified = verified.and_then(|()| {
            if !process_alive(owner) || !process_alive(verifier) {
                bail!("R verification was cancelled before authorization committed");
            }
            if read_acl_state(installation_id, root)?.is_some_and(|state| {
                state
                    .leases
                    .iter()
                    .any(|lease| lease.lease_id == pending.lease_id)
            }) {
                bail!("R verifier has not released its filesystem lease");
            }
            Ok(())
        });
        if let Err(error) = verified {
            // Stop the exact authenticated verifier (and its Job) before recovering its lease.
            if process_alive(verifier) {
                unsafe { TerminateProcess(verifier, 1) }.context("stop failed R verifier")?;
                unsafe { WaitForSingleObject(verifier, INFINITE) };
            }
            return match rollback_verified_runtime_access(
                installation_id,
                &root,
                &record,
                Some(&previous),
            ) {
                Ok(()) => Err(error),
                Err(rollback) => {
                    Err(error.context(format!("R access rollback also failed: {rollback:#}")))
                }
            };
        }
        let mut owned = record;
        owned.pending_runtime_access = None;
        owned.schema_version = RECEIPT_SCHEMA;
        owned.state = OwnershipState::Owned;
        refresh_owned_runtime_acl_snapshots(installation_id, root)?;
        commit_receipt(&root, &owned)?;
        fs::remove_file(journal_path(&root)).context("finish verified R access")?;
        Ok(())
    }

    const R_VERIFICATION_SCRIPT: &str = "stopifnot(requireNamespace(\"jsonlite\", quietly=TRUE)); normalizePath(.libPaths(), mustWork=TRUE); cat(\"OPEN_SCIENCE_R_ACCESS_OK\")";

    fn run_completed_r_probe(run: impl FnOnce(std::io::PipeWriter) -> Result<u32>) -> Result<u32> {
        let (mut reader, writer) = std::io::pipe().context("create R verification output pipe")?;
        let output = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
            let mut tail = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = reader.read(&mut buffer)?;
                if count == 0 {
                    return Ok(tail);
                }
                tail.extend_from_slice(&buffer[..count]);
                if tail.len() > 1024 * 1024 {
                    tail.drain(..tail.len() - 1024 * 1024);
                }
            }
        });
        let result = run(writer);
        let stdout = output
            .join()
            .map_err(|_| anyhow::anyhow!("R output reader failed"))??;
        if matches!(result, Ok(0))
            && !stdout
                .windows(b"OPEN_SCIENCE_R_ACCESS_OK".len())
                .any(|window| window == b"OPEN_SCIENCE_R_ACCESS_OK")
        {
            bail!("R protocol verification exited without its completion marker");
        }
        result
    }

    fn validate_runtime_verification(
        pending: &PendingRuntimeAccess,
        spec: &LaunchSpec,
    ) -> Result<()> {
        let executable =
            fs::canonicalize(&spec.executable).context("resolve R verification executable")?;
        let executable = executable.to_string_lossy();
        let executable = executable.strip_prefix(r"\\?\").unwrap_or(&executable);
        if !paths_equal(&pending.executable, Path::new(executable))
            || spec.verbatim_arguments
            || spec.arguments != ["--vanilla", "-e", R_VERIFICATION_SCRIPT]
        {
            bail!(
                "Only the fixed selected R protocol verification is admitted during authorization"
            );
        }
        Ok(())
    }

    pub fn verify_runtime_access(
        installation_id: &str,
        requested_root: &str,
        ticket: &str,
        owner_pid: u32,
        spec: LaunchSpec,
    ) -> Result<u32> {
        let name = wide(&verification_pipe_name(ticket)?);
        let owner = Handle(
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, owner_pid) }
                .context("open R verification owner")?,
        );
        let mut pipe = loop {
            // UAC waits for a person, not a protocol deadline. Cancellation terminates this
            // verifier; a closed initiating app must also end the wait without leaving an orphan.
            if !process_alive(owner.0) {
                bail!("R authorization owner exited");
            }
            if let Ok(handle) = unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_MODE(0),
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            } {
                break unsafe { fs::File::from_raw_handle(handle.0) };
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        if read_verification_message(&mut pipe, || process_alive(owner.0))? != "ready" {
            bail!("Invalid R authorization readiness");
        }
        let result = (|| -> Result<u32> {
            let lock = OperationLock::acquire(installation_id)?;
            let root = ownership_directory(installation_id, requested_root)?;
            recover_acl_leases(installation_id, &root, false)?;
            let record = ownership_record(installation_id, &root)?
                .context("Missing R verification journal")?;
            let pending = record
                .pending_runtime_access
                .as_ref()
                .context("R access is not awaiting verification")?;
            validate_runtime_verification(pending, &spec)?;
            let capability_name = command_capability_name(installation_id, &pending.lease_id);
            let mut capability = CommandCapability::new(capability_name)?;
            let sid = profile_sid(&record.profile_name)?;
            let mut lease = AclLease::acquire(
                installation_id,
                &root,
                pending.lease_id.clone(),
                &capability,
                &spec,
            )?;
            let result = run_completed_r_probe(|writer| {
                let stdout = HANDLE(writer.as_raw_handle());
                unsafe { SetHandleInformation(stdout, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
                    .context("inherit R verification output")?;
                launch_child(&spec, sid.0, &mut capability, lock, 20_000, Some(stdout))
            });
            lease.release()?;
            result
        })();
        let passed = matches!(result, Ok(0));
        pipe.write_all(if passed { b"commit\n" } else { b"rollback\n" })
            .context("return R verification result")?;
        if passed {
            if read_verification_message(&mut pipe, || process_alive(owner.0))? != "committed" {
                bail!("R authorization was not committed");
            }
        }
        result
    }

    pub fn setup_network(installation_id: &str, requested_root: &str) -> Result<()> {
        let _transaction = runtime_access_guard(installation_id)?;
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let record = ownership_record(installation_id, &ownership_root)?
            .context("prepare AppContainer setup before configuring network resources")?;
        let previous = read_record(&receipt_path(&ownership_root))?;
        if let Some(previous) = &previous {
            validate_record(previous, installation_id)?;
        }
        // A crashed verifier must never be promoted by the generic protected-mode repair path.
        if record.pending_runtime_access.is_some() {
            let previous = previous
                .as_ref()
                .context("Previous R ownership receipt is missing; preserving journal")?;
            return rollback_verified_runtime_access(
                installation_id,
                &ownership_root,
                &record,
                Some(previous),
            );
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
            reconcile_runtime_directories(&record, previous.as_ref())?;
            refresh_owned_runtime_acl_snapshots(installation_id, &ownership_root)?;
            let mut owned = record.clone();
            owned.state = OwnershipState::Owned;
            commit_receipt(&ownership_root, &owned)?;
            Ok(())
        })();
        if let Err(error) = install_result {
            let rollback = (|| -> Result<()> {
                rollback_runtime_directories(&record, previous.as_ref())?;
                refresh_owned_runtime_acl_snapshots(installation_id, &ownership_root)?;
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
        let _transaction = runtime_access_guard(installation_id)?;
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
            if creating.pending_runtime_access.is_some() {
                bail!("R access verification has not committed; preserving pending journal");
            }
            if creating.ownership_token != record.ownership_token {
                bail!("AppContainer ownership records disagree; preserving resources");
            }
            fs::remove_file(&journal).context("remove completed AppContainer creation journal")?;
        }
        Ok(())
    }

    pub fn prepare_remove(installation_id: &str, requested_root: &str) -> Result<()> {
        let _transaction = runtime_access_guard(installation_id)?;
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
        let _transaction = runtime_access_guard(installation_id)?;
        let _lock = OperationLock::acquire(installation_id)?;
        let ownership_root = ownership_directory(installation_id, requested_root)?;
        let Some(record) = ownership_record(installation_id, &ownership_root)? else {
            return Ok(());
        };
        let sid = profile_sid(&record.profile_name)?;
        stop_profile_processes(sid.0)?;
        let mut directories = runtime_directories(&record);
        if let Some(previous) = read_record(&receipt_path(&ownership_root))? {
            validate_record(&previous, installation_id)?;
            directories.extend(runtime_directories(&previous));
        }
        for path in directories {
            if Path::new(&path).exists() {
                super::directory_access::update(&path, &record.profile_sid, false, true)?;
            }
        }
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
        let _transaction = runtime_access_guard(installation_id)?;
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
            // SetFileSecurityW consumes the request bit to retain AUTO_INHERITED, including
            // on protected DACLs where /inheritancelevel:e would change the protection policy.
            auto_inherit_bits |= SE_DACL_AUTO_INHERITED.0 | SE_DACL_AUTO_INHERIT_REQ.0;
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

    fn refresh_owned_runtime_acl_snapshots(installation_id: &str, root: &Path) -> Result<()> {
        if let Some(mut state) = read_acl_state(installation_id, root)? {
            refresh_runtime_acl_snapshots(&mut state, root)?;
        }
        Ok(())
    }

    fn refresh_runtime_acl_snapshots(state: &mut AclState, root: &Path) -> Result<()> {
        let Some(record) = ownership_record(&state.installation_id, root)? else {
            return Ok(());
        };
        let mut directories = runtime_directories(&record);
        if let Some(previous) = read_record(&receipt_path(root))? {
            validate_record(&previous, &state.installation_id)?;
            if previous.ownership_token != record.ownership_token
                || previous.profile_sid != record.profile_sid
            {
                bail!("Runtime ACL ownership records disagree; preserving snapshots");
            }
            directories.extend(runtime_directories(&previous));
        }
        let mut changed = false;
        for snapshot in &mut state.snapshots {
            if !Path::new(&snapshot.path).exists() {
                continue;
            }
            // Runtime receipts use canonical paths, while command snapshots retain the caller's
            // spelling (including short names, junctions, and extended-length prefixes).
            let canonical = fs::canonicalize(&snapshot.path)
                .with_context(|| format!("resolve runtime ACL snapshot {}", snapshot.path))?;
            let canonical = canonical.to_string_lossy();
            let canonical = canonical.strip_prefix(r"\\?\").unwrap_or(&canonical);
            if !directories
                .iter()
                .any(|path| paths_equal(path, Path::new(canonical)))
            {
                continue;
            }
            // A command baseline predates a later runtime grant or revocation. Preserve only
            // the exact owned permanent ACE currently installed, never another command's ACEs.
            let granted = super::directory_access::is_granted(&snapshot.path, &record.profile_sid)?;
            let updated = runtime_snapshot_dacl(snapshot, &record.profile_sid, granted)?;
            if updated != snapshot.dacl_sddl {
                snapshot.dacl_sddl = updated;
                changed = true;
            }
        }
        if changed {
            write_acl_state(root, state)?;
        }
        Ok(())
    }

    fn runtime_snapshot_dacl(
        snapshot: &AclSnapshot,
        identity: &str,
        granted: bool,
    ) -> Result<String> {
        const LIST_DIRECTORY: u32 = 0x0012_0089;
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let encoded = wide(&snapshot.dacl_sddl);
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(encoded.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }?;
        let _descriptor = LocalAllocation(descriptor.0);
        let mut present = BOOL::default();
        let mut defaulted = BOOL::default();
        let mut source = std::ptr::null_mut();
        unsafe {
            GetSecurityDescriptorDacl(descriptor, &mut present, &mut source, &mut defaulted)
        }?;
        if !present.as_bool() || source.is_null() {
            bail!("Runtime ACL snapshot has no concrete DACL");
        }
        let mut sid = PSID::default();
        let identity = wide(identity);
        unsafe { ConvertStringSidToSidW(PCWSTR(identity.as_ptr()), &mut sid) }?;
        let _sid = LocalAllocation(sid.0);
        let mut info = ACL_SIZE_INFORMATION::default();
        unsafe {
            GetAclInformation(
                source,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        }?;
        let bytes = info.AclBytesInUse as usize
            + size_of::<ACCESS_ALLOWED_ACE>()
            + unsafe { GetLengthSid(sid) } as usize;
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let target = storage.as_mut_ptr().cast::<ACL>();
        unsafe {
            InitializeAcl(
                target,
                (storage.len() * size_of::<usize>()) as u32,
                ACL_REVISION_DS,
            )
        }?;
        let mut found = false;
        let mut inserted = !granted;
        for index in 0..info.AceCount {
            let mut ace = std::ptr::null_mut();
            unsafe { GetAce(source, index, &mut ace) }?;
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceType <= 1 && header.AceSize as usize >= size_of::<ACCESS_ALLOWED_ACE>() {
                let entry = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
                if unsafe { EqualSid(sid, PSID((&entry.SidStart as *const u32).cast_mut().cast())) }
                    .is_ok()
                {
                    if found
                        || header.AceType != 0
                        || header.AceFlags != 0
                        || entry.Mask != LIST_DIRECTORY
                    {
                        bail!(
                            "Unowned runtime permissions in ACL snapshot; preserving {}",
                            snapshot.path
                        );
                    }
                    found = true;
                    continue;
                }
            }
            if !inserted && header.AceFlags & INHERITED_ACE.0 as u8 != 0 {
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
                    ace,
                    header.AceSize as u32,
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
        serialize_dacl(target, &snapshot.path)
    }

    fn rebuild_acl_state(state: &mut AclState, ownership_root: &Path) -> Result<()> {
        refresh_runtime_acl_snapshots(state, ownership_root)?;
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
        let changes_permissions = state
            .leases
            .iter()
            .find(|lease| lease.lease_id == lease_id)
            .map_or(true, |lease| !lease.grants.is_empty());
        state.leases.retain(|lease| lease.lease_id != lease_id);
        write_acl_state(ownership_root, &state)?;
        if changes_permissions {
            rebuild_acl_state(&mut state, ownership_root)?;
        }
        remove_acl_receipt(&acl_directory(ownership_root).join(format!("{lease_id}.json")))?;
        if changes_permissions {
            prune_acl_snapshots(&mut state);
        }
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
        let original_lease_count = state.leases.len();
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
        // A complete set of live, matching receipts has nothing to recover. Rebuilding it
        // would revoke and propagate the same active grants through entire runtime trees.
        if !retained.is_empty()
            && retained.len() == original_lease_count
            && retained.len() == receipts.len()
        {
            return Ok(());
        }
        state.leases = retained;
        write_acl_state(ownership_root, &state)?;
        rebuild_acl_state(&mut state, ownership_root)?;
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
            // Network-fence probes have no filesystem grants. Adding their process receipt
            // must not revoke and re-propagate another live kernel's directory permissions.
            let changes_permissions = !record.grants.is_empty();
            if let Err(error) = write_acl_record(&path, &record).and_then(|()| {
                if changes_permissions {
                    rebuild_acl_state(&mut state, ownership_root)
                } else {
                    Ok(())
                }
            }) {
                state
                    .leases
                    .retain(|lease| lease.lease_id != record.lease_id);
                let rollback = write_acl_state(ownership_root, &state)
                    .and_then(|()| {
                        if changes_permissions {
                            rebuild_acl_state(&mut state, ownership_root)
                        } else {
                            Ok(())
                        }
                    })
                    .and_then(|()| remove_acl_receipt(&path))
                    .and_then(|()| {
                        if changes_permissions {
                            prune_acl_snapshots(&mut state);
                        }
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

    fn run_suspended_process_in_job(
        spec: &LaunchSpec,
        process: &Handle,
        thread: &Handle,
        terminate: &mut TerminateOnDrop,
        operation_lock: Option<OperationLock>,
        timeout: u32,
    ) -> Result<u32> {
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
            bail!("resume supervised process");
        }
        terminate.armed = false;
        drop(operation_lock);
        let process_wait = unsafe { WaitForSingleObject(process.0, timeout) };
        if process_wait == WAIT_TIMEOUT {
            unsafe { TerminateJobObject(job.0, 1) }.context("stop timed-out R verification")?;
            unsafe { WaitForSingleObject(process.0, INFINITE) };
        }
        if process_wait != WAIT_OBJECT_0 && process_wait != WAIT_TIMEOUT {
            bail!("wait for supervised process returned {process_wait:?}");
        }
        let mut exit_code = 1u32;
        unsafe { GetExitCodeProcess(process.0, &mut exit_code) }
            .context("read process exit code")?;
        // A successful supervisor exit is an explicit termination proof for cleanup callers. Do
        // not rely only on KILL_ON_JOB_CLOSE: terminate the remaining helpers and wait until the
        // Job reports zero active processes before returning.
        unsafe { TerminateJobObject(job.0, 1) }.context("terminate process job")?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(job.0),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    None,
                )
            }
            .context("query process job accounting")?;
            if accounting.ActiveProcesses == 0 {
                break;
            }
            if Instant::now() >= deadline {
                bail!("timed out waiting for process job termination");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        match (&spec.termination_proof_path, &spec.termination_proof_token) {
            (Some(path), Some(token)) => {
                fs::write(path, token).context("write process tree termination proof")?;
            }
            (None, None) => {}
            _ => bail!("incomplete process tree termination proof specification"),
        }
        drop(job);
        if process_wait == WAIT_TIMEOUT {
            bail!("R verification timed out");
        }
        Ok(exit_code)
    }

    fn launch_child(
        spec: &LaunchSpec,
        app_container_sid: PSID,
        capability: &mut CommandCapability,
        operation_lock: OperationLock,
        timeout: u32,
        stdout: Option<HANDLE>,
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
        startup.StartupInfo.hStdOutput =
            stdout.unwrap_or(HANDLE(std::io::stdout().as_raw_handle()));
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

        run_suspended_process_in_job(
            spec,
            &process,
            &thread,
            &mut terminate,
            Some(operation_lock),
            timeout,
        )
    }

    pub fn supervise(spec: LaunchSpec) -> Result<u32> {
        let mut startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: HANDLE(std::io::stdin().as_raw_handle()),
            hStdOutput: HANDLE(std::io::stdout().as_raw_handle()),
            hStdError: HANDLE(std::io::stderr().as_raw_handle()),
            ..Default::default()
        };
        let mut mutable_command = wide(&command_line(&spec));
        let current_directory = wide(&spec.cwd);
        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        unsafe {
            CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(mutable_command.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_SUSPENDED,
                None,
                PCWSTR(current_directory.as_ptr()),
                &mut startup,
                &mut process_info,
            )
        }
        .context("create supervised process")?;
        let process = Handle(process_info.hProcess);
        let thread = Handle(process_info.hThread);
        let mut terminate = TerminateOnDrop {
            process: process.0,
            armed: true,
        };
        run_suspended_process_in_job(&spec, &process, &thread, &mut terminate, None, INFINITE)
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
        let result = launch_child(
            &spec,
            sid.0,
            &mut capability,
            operation_lock,
            INFINITE,
            None,
        );
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
        fn directory_listing_can_authorize_and_revoke_an_in_use_directory() {
            use std::os::windows::fs::OpenOptionsExt;

            for protected in [false, true] {
                let root = unique_test_root("directory-listing-in-use");
                let child = root.join("child");
                fs::create_dir_all(&child).unwrap();
                let path = root.to_string_lossy();
                let child_path = child.to_string_lossy();
                if protected {
                    run_icacls(
                        &path,
                        &["/inheritancelevel:d", "/Q"],
                        "protect test directory",
                    )
                    .unwrap();
                }
                let original = capture_acl_snapshot(&path).unwrap();
                // A legacy child's control flags make accidental inheritance propagation observable,
                // even when reapplying the parent's existing ACEs would otherwise look unchanged.
                let mut child_legacy = capture_acl_snapshot(&child_path).unwrap();
                child_legacy.dacl_auto_inherited = false;
                child_legacy.dacl_auto_inherit_requested = false;
                restore_acl_snapshot(&child_legacy).unwrap();
                let child_original = capture_acl_snapshot(&child_path).unwrap();
                let capability = CommandCapability::new(format!(
                    "open-science.test.{}",
                    new_resource_key().unwrap()
                ))
                .unwrap();
                let identity = sid_text(capability.sid()).unwrap();
                // Match an ancestor held as a process working directory: reading and writing are
                // shared, but deletion is not. ACL updates must not request deletion access.
                let held = fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0x1 | 0x2)
                    .custom_flags(0x0200_0000) // FILE_FLAG_BACKUP_SEMANTICS
                    .open(&root)
                    .unwrap();
                let result = (|| -> Result<()> {
                    super::super::directory_access::update(&path, &identity, true, false)?;
                    assert!(super::super::directory_access::is_granted(
                        &path, &identity
                    )?);
                    let granted = capture_acl_snapshot(&path)?;
                    assert_eq!(granted.dacl_protected, original.dacl_protected);
                    assert_eq!(granted.dacl_auto_inherited, original.dacl_auto_inherited);
                    assert_eq!(
                        granted.dacl_auto_inherit_requested,
                        original.dacl_auto_inherit_requested
                    );
                    assert_eq!(capture_acl_snapshot(&child_path)?, child_original);
                    super::super::directory_access::update(&path, &identity, false, true)?;
                    assert_eq!(capture_acl_snapshot(&path)?, original);
                    assert_eq!(capture_acl_snapshot(&child_path)?, child_original);
                    Ok(())
                })();
                drop(held);
                restore_acl_snapshot(&original).unwrap();
                fs::remove_dir_all(&root).unwrap();
                result.unwrap();
            }
        }

        #[test]
        fn directory_listing_preserves_children_and_removes_only_owned_permissions() {
            let root = unique_test_root("directory-listing");
            let child = root.join("child");
            fs::create_dir_all(&child).unwrap();
            let path = root.to_string_lossy();
            let child_path = child.to_string_lossy();
            let original = capture_acl_snapshot(&path).unwrap();
            let mut legacy_control = original.clone();
            legacy_control.dacl_auto_inherited = false;
            legacy_control.dacl_auto_inherit_requested = false;
            restore_acl_snapshot(&legacy_control).unwrap();
            let original = capture_acl_snapshot(&path).unwrap();
            let child_original = capture_acl_snapshot(&child_path).unwrap();
            let capability = CommandCapability::new(format!(
                "open-science.test.{}",
                new_resource_key().unwrap()
            ))
            .unwrap();
            let identity = sid_text(capability.sid()).unwrap();
            super::super::directory_access::update(&path, &identity, true, false).unwrap();
            assert_eq!(capture_acl_snapshot(&child_path).unwrap(), child_original);
            assert_ne!(capture_acl_snapshot(&path).unwrap(), original);
            assert!(super::super::directory_access::update(&path, &identity, true, false).is_err());
            super::super::directory_access::update(&path, &identity, true, true).unwrap();
            super::super::directory_access::update(&path, &identity, false, true).unwrap();
            super::super::directory_access::update(&path, &identity, false, true).unwrap();
            assert_eq!(capture_acl_snapshot(&path).unwrap(), original);
            run_icacls(
                &path,
                &["/grant:r", &format!("*{identity}:RX"), "/Q"],
                "alter test grant",
            )
            .unwrap();
            let changed = capture_acl_snapshot(&path).unwrap();
            assert!(super::super::directory_access::update(&path, &identity, false, true).is_err());
            assert_eq!(capture_acl_snapshot(&path).unwrap(), changed);
            restore_acl_snapshot(&original).unwrap();
            fs::remove_dir_all(&root).unwrap();
        }

        #[test]
        fn runtime_directory_reconciliation_preserves_shared_paths_and_retries_after_rollback() {
            let installation_id = "fedcba9876543210fedcba98";
            let parent = unique_test_root("runtime-reconciliation");
            let ownership = parent.join(installation_id);
            let request_root = ownership.to_string_lossy();
            prepare_setup(installation_id, &request_root).unwrap();
            let empty = read_record(&journal_path(&ownership)).unwrap().unwrap();
            cancel_setup(installation_id, &request_root).unwrap();
            let shared = parent.join("shared");
            let first = shared.join("a");
            let second = shared.join("b");
            fs::create_dir_all(&first).unwrap();
            fs::create_dir_all(&second).unwrap();
            let snapshot = capture_acl_snapshot(&shared.to_string_lossy()).unwrap();
            let second_snapshot = capture_acl_snapshot(&second.to_string_lossy()).unwrap();
            // Exercise the ACL reconciliation boundary on owned temporary directories. Full profile
            // setup and WFP removal require the elevated integration suite; no drive ACL is changed here.
            let entry = |leaf: &Path| RuntimeDirectoryAccess {
                executable: leaf.join("bin/Rscript.exe").to_string_lossy().into_owned(),
                selected_executable: leaf.join("bin/Rscript.exe").to_string_lossy().into_owned(),
                directories: vec![
                    shared.to_string_lossy().into_owned(),
                    leaf.to_string_lossy().into_owned(),
                ],
            };
            let mut both = empty.clone();
            both.runtime_directory_access = vec![entry(&first), entry(&second)];
            reconcile_runtime_directories(&both, Some(&empty)).unwrap();
            let mut remaining = both.clone();
            remaining.runtime_directory_access.remove(0);
            reconcile_runtime_directories(&remaining, Some(&both)).unwrap();
            assert!(
                super::super::directory_access::is_granted(
                    &shared.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            assert!(
                super::super::directory_access::is_granted(
                    &second.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            assert!(
                !super::super::directory_access::is_granted(
                    &first.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            reconcile_runtime_directories(&empty, Some(&remaining)).unwrap();
            reconcile_runtime_directories(&empty, Some(&remaining)).unwrap();
            assert_eq!(
                capture_acl_snapshot(&shared.to_string_lossy()).unwrap(),
                snapshot
            );

            let missing = shared.join("z-missing");
            reconcile_runtime_directories(&both, Some(&empty)).unwrap();
            run_icacls(
                &second.to_string_lossy(),
                &["/grant:r", &format!("*{}:RX", empty.profile_sid), "/Q"],
                "alter cleanup test grant",
            )
            .unwrap();
            let changed_second = capture_acl_snapshot(&second.to_string_lossy()).unwrap();
            assert!(reconcile_runtime_directories(&empty, Some(&both)).is_err());
            assert!(
                !super::super::directory_access::is_granted(
                    &first.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            assert_eq!(
                capture_acl_snapshot(&second.to_string_lossy()).unwrap(),
                changed_second
            );
            restore_acl_snapshot(&second_snapshot).unwrap();
            super::super::directory_access::update(
                &second.to_string_lossy(),
                &empty.profile_sid,
                true,
                true,
            )
            .unwrap();
            reconcile_runtime_directories(&empty, Some(&both)).unwrap();
            assert_eq!(
                capture_acl_snapshot(&shared.to_string_lossy()).unwrap(),
                snapshot
            );
            assert_eq!(
                capture_acl_snapshot(&second.to_string_lossy()).unwrap(),
                second_snapshot
            );
            let mut interrupted = empty.clone();
            interrupted.runtime_directory_access = vec![entry(&first), entry(&missing)];
            assert!(reconcile_runtime_directories(&interrupted, Some(&empty)).is_err());
            assert!(
                super::super::directory_access::is_granted(
                    &first.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            rollback_runtime_directories(&interrupted, Some(&empty)).unwrap();
            assert_eq!(
                capture_acl_snapshot(&shared.to_string_lossy()).unwrap(),
                snapshot
            );
            assert!(
                !super::super::directory_access::is_granted(
                    &first.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            fs::create_dir_all(&missing).unwrap();
            reconcile_runtime_directories(&interrupted, Some(&empty)).unwrap();
            assert!(
                super::super::directory_access::is_granted(
                    &missing.to_string_lossy(),
                    &empty.profile_sid
                )
                .unwrap()
            );
            reconcile_runtime_directories(&empty, Some(&interrupted)).unwrap();
            fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn prepare_setup_does_not_create_profile_before_elevation() {
            let installation_id = "fedcba9876543210fedcba96";
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
        fn selected_r_access_upgrades_legacy_journal_and_cancellation_preserves_receipt() {
            let installation_id = "fedcba9876543210fedcba97";
            let parent = unique_test_root("legacy-runtime-access");
            let root = parent.join(installation_id);
            let request_root = root.to_string_lossy();
            prepare_setup(installation_id, &request_root).unwrap();
            let mut record = read_record(&journal_path(&root)).unwrap().unwrap();
            record.schema_version = 4;
            record.state = OwnershipState::Owned;
            write_new_record(&receipt_path(&root), &record).unwrap();
            fs::remove_file(journal_path(&root)).unwrap();
            let home = parent.join("R");
            fs::create_dir_all(home.join("bin/x64")).unwrap();
            fs::create_dir_all(home.join("etc")).unwrap();
            fs::create_dir_all(home.join("library")).unwrap();
            let executable = home.join("bin/x64/Rscript.exe");
            fs::write(&executable, b"test fixture; never executed").unwrap();
            prepare_runtime_access(
                installation_id,
                &request_root,
                &executable.to_string_lossy(),
                false,
                false,
            )
            .unwrap();
            let pending = read_record(&journal_path(&root)).unwrap().unwrap();
            assert_eq!(pending.schema_version, 5);
            assert_eq!(pending.runtime_directory_access.len(), 1);
            assert!(
                runtime_access_status(
                    installation_id,
                    &request_root,
                    &executable.to_string_lossy(),
                )
                .is_err(),
                "pending authorization must not report successful absent permissions"
            );
            let entry = &pending.runtime_directory_access[0];
            assert_eq!(
                entry.directories,
                r_installation_directories(Path::new(&entry.executable)).unwrap()
            );
            assert!(
                !entry
                    .directories
                    .contains(&home.to_string_lossy().into_owned())
            );
            let partial_directory = parent.to_string_lossy();
            super::super::directory_access::update(
                &partial_directory,
                &record.profile_sid,
                true,
                false,
            )
            .unwrap();
            assert!(cancel_setup(installation_id, &request_root).is_err());
            assert!(journal_path(&root).exists());
            assert!(receipt_path(&root).exists());
            super::super::directory_access::update(
                &partial_directory,
                &record.profile_sid,
                false,
                true,
            )
            .unwrap();
            cancel_setup(installation_id, &request_root).unwrap();
            assert_eq!(
                read_record(&receipt_path(&root))
                    .unwrap()
                    .unwrap()
                    .schema_version,
                4
            );
            assert!(!journal_path(&root).exists());
            fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn runtime_access_survives_command_recovery_and_stays_revoked_after_rollback() {
            for live_owner in [false, true] {
                for protected in [false, true] {
                    for interrupted in [false, true] {
                        let installation_id = "cccc1212cccc1212cccc1212";
                        let parent = unique_test_root("runtime-overlapping-snapshot");
                        let root = parent.join(installation_id);
                        prepare_setup(installation_id, &root.to_string_lossy()).unwrap();
                        let mut previous = read_record(&journal_path(&root)).unwrap().unwrap();
                        previous.state = OwnershipState::Owned;
                        write_new_record(&receipt_path(&root), &previous).unwrap();
                        fs::remove_file(journal_path(&root)).unwrap();
                        let home = parent.join("R");
                        for directory in ["bin", "etc", "library"] {
                            fs::create_dir_all(home.join(directory)).unwrap();
                        }
                        let executable = home.join("bin/Rscript.exe");
                        fs::write(&executable, b"never executed").unwrap();
                        prepare_runtime_access(
                            installation_id,
                            &root.to_string_lossy(),
                            &executable.to_string_lossy(),
                            false,
                            true,
                        )
                        .unwrap();
                        let record = read_record(&journal_path(&root)).unwrap().unwrap();
                        run_icacls(
                            &parent.to_string_lossy(),
                            &["/deny", "*S-1-5-2:R", "/Q"],
                            "add unrelated network deny to fixture",
                        )
                        .unwrap();
                        run_icacls(
                            &parent.to_string_lossy(),
                            &["/grant:r", "*S-1-5-7:R", "/Q"],
                            "add unrelated anonymous allow to fixture",
                        )
                        .unwrap();
                        if protected {
                            run_icacls(
                                &parent.to_string_lossy(),
                                &["/inheritancelevel:d", "/Q"],
                                "protect fixture ACL",
                            )
                            .unwrap();
                        }
                        let mut snapshot = capture_acl_snapshot(&parent.to_string_lossy()).unwrap();
                        let original = snapshot.clone();
                        // The same directory can enter a command lease under another Windows spelling.
                        snapshot.path = format!(r"\\?\{}", snapshot.path);
                        let lease_id = new_lease_id().unwrap();
                        let capability_name = command_capability_name(installation_id, &lease_id);
                        let capability = CommandCapability::new(capability_name.clone()).unwrap();
                        let lease = AclLeaseRecord {
                            schema_version: ACL_LEASE_SCHEMA,
                            installation_id: installation_id.into(),
                            lease_id: lease_id.clone(),
                            owner_process_id: if live_owner {
                                unsafe { GetCurrentProcessId() }
                            } else {
                                u32::MAX
                            },
                            capability_name,
                            capability_sid: sid_text(capability.sid()).unwrap(),
                            grants: vec![AclLeaseGrant {
                                path: snapshot.path.clone(),
                                access: AclGrant::ModifyTree,
                                protected_boundary: false,
                            }],
                        };
                        write_acl_record(
                            &acl_directory(&root).join(format!("{lease_id}.json")),
                            &lease,
                        )
                        .unwrap();
                        write_acl_state(
                            &root,
                            &AclState {
                                schema_version: ACL_STATE_SCHEMA,
                                installation_id: installation_id.into(),
                                snapshots: vec![snapshot],
                                leases: vec![lease],
                            },
                        )
                        .unwrap();
                        // Reproduce the real ordering: the elevated helper grants this ancestor, then the
                        // unprivileged verifier recovers the old command snapshot before its probe.
                        super::super::directory_access::update(
                            &parent.to_string_lossy(),
                            &record.profile_sid,
                            true,
                            false,
                        )
                        .unwrap();
                        recover_acl_leases(installation_id, &root, false).unwrap();
                        let preserved = super::super::directory_access::is_granted(
                            &parent.to_string_lossy(),
                            &record.profile_sid,
                        )
                        .unwrap();
                        let retained =
                            read_acl_state(installation_id, &root)
                                .unwrap()
                                .is_some_and(|state| {
                                    state.leases.iter().any(|lease| lease.lease_id == lease_id)
                                });
                        if interrupted {
                            // Simulate process loss after removing the physical grant but before
                            // rollback could refresh the live baseline and remove its journal.
                            rollback_runtime_directories(&record, Some(&previous)).unwrap();
                            cancel_setup(installation_id, &root.to_string_lossy()).unwrap();
                        } else {
                            rollback_verified_runtime_access(
                                installation_id,
                                &root,
                                &record,
                                Some(&previous),
                            )
                            .unwrap();
                        }
                        // The journal is gone; another live command rebuild must not resurrect the grant.
                        recover_acl_leases(installation_id, &root, false).unwrap();
                        let resurrected = super::super::directory_access::is_granted(
                            &parent.to_string_lossy(),
                            &record.profile_sid,
                        )
                        .unwrap();
                        super::super::directory_access::update(
                            &parent.to_string_lossy(),
                            &record.profile_sid,
                            false,
                            true,
                        )
                        .unwrap();
                        release_acl_lease_locked(installation_id, &root, &lease_id).unwrap();
                        let restored = capture_acl_snapshot(&parent.to_string_lossy()).unwrap();
                        fs::remove_dir_all(&parent).unwrap();
                        assert_eq!(retained, live_owner);
                        assert_eq!(restored, original);
                        assert!(
                            preserved,
                            "recovering an old command snapshot removed the new runtime directory grant"
                        );
                        assert!(
                            !resurrected,
                            "a live command snapshot resurrected the rolled-back runtime grant"
                        );
                    }
                }
            }
        }

        #[test]
        fn runtime_snapshot_reconciliation_rejects_unowned_baseline_aces() {
            let installation_id = "dddd1212dddd1212dddd1212";
            let parent = unique_test_root("runtime-unowned-snapshot");
            let root = parent.join(installation_id);
            prepare_setup(installation_id, &root.to_string_lossy()).unwrap();
            let mut previous = read_record(&journal_path(&root)).unwrap().unwrap();
            previous.state = OwnershipState::Owned;
            write_new_record(&receipt_path(&root), &previous).unwrap();
            fs::remove_file(journal_path(&root)).unwrap();
            let home = parent.join("R");
            for directory in ["bin", "etc", "library"] {
                fs::create_dir_all(home.join(directory)).unwrap();
            }
            let executable = home.join("bin/Rscript.exe");
            fs::write(&executable, b"never executed").unwrap();
            prepare_runtime_access(
                installation_id,
                &root.to_string_lossy(),
                &executable.to_string_lossy(),
                false,
                true,
            )
            .unwrap();
            let original = capture_acl_snapshot(&parent.to_string_lossy()).unwrap();
            for aces in [
                format!("(A;;FA;;;{})", previous.profile_sid),
                format!("(D;;0x120089;;;{})", previous.profile_sid),
                format!("(A;ID;0x120089;;;{})", previous.profile_sid),
                format!(
                    "(A;;0x120089;;;{0})(A;;0x120089;;;{0})",
                    previous.profile_sid
                ),
            ] {
                let mut snapshot = original.clone();
                snapshot.path = format!(r"\\?\{}", snapshot.path);
                snapshot.dacl_sddl.push_str(&aces);
                write_acl_state(
                    &root,
                    &AclState {
                        schema_version: ACL_STATE_SCHEMA,
                        installation_id: installation_id.into(),
                        snapshots: vec![snapshot],
                        leases: vec![],
                    },
                )
                .unwrap();
                let error =
                    refresh_owned_runtime_acl_snapshots(installation_id, &root).unwrap_err();
                assert!(format!("{error:#}").contains("Unowned runtime permissions"));
                assert_eq!(
                    capture_acl_snapshot(&parent.to_string_lossy()).unwrap(),
                    original
                );
            }
            fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn empty_command_lease_does_not_rebuild_a_live_filesystem_lease() {
            let installation_id = "abab1212abab1212abab1213";
            let parent = unique_test_root("empty-command-lease");
            let root = parent.join(installation_id);
            let directory = parent.join("live-runtime");
            fs::create_dir_all(&directory).unwrap();
            let make_capability = || {
                let id = new_lease_id().unwrap();
                let capability =
                    CommandCapability::new(command_capability_name(installation_id, &id)).unwrap();
                (id, capability)
            };
            let spec = LaunchSpec {
                executable: "unused".into(),
                arguments: vec![],
                verbatim_arguments: false,
                cwd: parent.to_string_lossy().into_owned(),
                read_only_roots: vec![directory.to_string_lossy().into_owned()],
                read_write_roots: vec![],
                denied_read_roots: vec![],
                denied_write_roots: vec![],
                termination_proof_path: None,
                termination_proof_token: None,
            };
            let (id, capability) = make_capability();
            let mut live =
                AclLease::acquire(installation_id, &root, id, &capability, &spec).unwrap();
            let before = fs::read(acl_state_path(&root)).unwrap();
            // A live process may retain its receipt after its data directory disappears.
            // An unrelated network probe must not try to re-grant that directory.
            fs::remove_dir(&directory).unwrap();
            recover_acl_leases(installation_id, &root, false).unwrap();
            assert_eq!(fs::read(acl_state_path(&root)).unwrap(), before);
            let empty = LaunchSpec {
                read_only_roots: vec![],
                ..spec
            };
            let (id, empty_capability) = make_capability();
            let mut probe =
                AclLease::acquire(installation_id, &root, id, &empty_capability, &empty).unwrap();
            probe.release().unwrap();
            assert_eq!(fs::read(acl_state_path(&root)).unwrap(), before);
            fs::create_dir(&directory).unwrap();

            // A granted lease can stop after removing its state entry but before restoring
            // ACLs. A different empty lease must preserve that interrupted removal's snapshot.
            let (id, second_capability) = make_capability();
            let mut second_probe =
                AclLease::acquire(installation_id, &root, id, &second_capability, &empty).unwrap();
            let mut interrupted = read_acl_state(installation_id, &root).unwrap().unwrap();
            let baseline = interrupted.snapshots[0].clone();
            apply_acl_grant(
                &baseline.path,
                &live.record.capability_sid,
                AclGrant::ReadOnlyTree,
            )
            .unwrap();
            assert_ne!(capture_acl_snapshot(&baseline.path).unwrap(), baseline);
            interrupted
                .leases
                .retain(|lease| lease.lease_id != live.record.lease_id);
            write_acl_state(&root, &interrupted).unwrap();
            second_probe.release().unwrap();
            assert_eq!(
                read_acl_state(installation_id, &root)
                    .unwrap()
                    .unwrap()
                    .snapshots,
                interrupted.snapshots
            );
            recover_acl_leases(installation_id, &root, false).unwrap();
            assert_eq!(capture_acl_snapshot(&baseline.path).unwrap(), baseline);
            live.release().unwrap();
            fs::remove_dir_all(parent).unwrap();
        }

        #[test]
        fn r_verification_recovers_dead_command_leases_before_acquiring_its_lease() {
            let installation_id = "abab1212abab1212abab1212";
            let parent = unique_test_root("verification-stale-lease");
            let root = parent.join(installation_id);
            prepare_setup(installation_id, &root.to_string_lossy()).unwrap();
            let mut previous = read_record(&journal_path(&root)).unwrap().unwrap();
            previous.state = OwnershipState::Owned;
            write_new_record(&receipt_path(&root), &previous).unwrap();
            fs::remove_file(journal_path(&root)).unwrap();
            let receipt_before = fs::read(receipt_path(&root)).unwrap();
            let home = parent.join("R");
            for directory in ["bin", "etc", "library"] {
                fs::create_dir_all(home.join(directory)).unwrap();
            }
            let executable = home.join("bin/Rscript.exe");
            fs::write(&executable, b"invalid executable; never runs user code").unwrap();
            prepare_runtime_access(
                installation_id,
                &root.to_string_lossy(),
                &executable.to_string_lossy(),
                false,
                true,
            )
            .unwrap();
            let missing = parent.join("old-kernel-figures");
            fs::create_dir(&missing).unwrap();
            let snapshot = capture_acl_snapshot(&missing.to_string_lossy()).unwrap();
            fs::remove_dir(&missing).unwrap();
            let lease_id = new_lease_id().unwrap();
            let capability_name = command_capability_name(installation_id, &lease_id);
            let capability = CommandCapability::new(capability_name.clone()).unwrap();
            // Windows process IDs are aligned; this nonzero identity cannot name a live process.
            let stale = AclLeaseRecord {
                schema_version: ACL_LEASE_SCHEMA,
                installation_id: installation_id.into(),
                lease_id: lease_id.clone(),
                owner_process_id: u32::MAX,
                capability_name,
                capability_sid: sid_text(capability.sid()).unwrap(),
                grants: vec![AclLeaseGrant {
                    path: missing.to_string_lossy().into_owned(),
                    access: AclGrant::ModifyTree,
                    protected_boundary: false,
                }],
            };
            write_acl_record(
                &acl_directory(&root).join(format!("{lease_id}.json")),
                &stale,
            )
            .unwrap();
            write_acl_state(
                &root,
                &AclState {
                    schema_version: ACL_STATE_SCHEMA,
                    installation_id: installation_id.into(),
                    snapshots: vec![snapshot],
                    leases: vec![stale],
                },
            )
            .unwrap();
            let ticket =
                format!("{}{}", new_lease_id().unwrap(), new_lease_id().unwrap()).replace('-', "");
            let verifier = Handle(
                unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        GetCurrentProcessId(),
                    )
                }
                .unwrap(),
            );
            let mut pipe = create_verification_pipe(&ticket, verifier.0).unwrap();
            let server = std::thread::spawn(move || {
                let started = Instant::now();
                while unsafe { ConnectNamedPipe(pipe_handle(&pipe), None) }
                    .is_err_and(|e| e.code() != ERROR_PIPE_CONNECTED.to_hresult())
                {
                    assert!(started.elapsed() < Duration::from_secs(10));
                    std::thread::sleep(Duration::from_millis(10));
                }
                pipe.write_all(b"ready\n").unwrap();
                assert_eq!(
                    read_verification_message(&mut pipe, || true).unwrap(),
                    "rollback"
                );
            });
            let result = verify_runtime_access(
                installation_id,
                &root.to_string_lossy(),
                &ticket,
                unsafe { GetCurrentProcessId() },
                LaunchSpec {
                    executable: executable.to_string_lossy().into_owned(),
                    arguments: vec![
                        "--vanilla".into(),
                        "-e".into(),
                        R_VERIFICATION_SCRIPT.into(),
                    ],
                    verbatim_arguments: false,
                    cwd: parent.to_string_lossy().into_owned(),
                    read_only_roots: vec![],
                    read_write_roots: vec![],
                    denied_read_roots: vec![],
                    denied_write_roots: vec![],
                    termination_proof_path: None,
                    termination_proof_token: None,
                },
            );
            server.join().unwrap();
            let error = format!("{:#}", result.unwrap_err());
            let stale_remains = acl_directory(&root)
                .join(format!("{lease_id}.json"))
                .exists();
            assert_eq!(fs::read(receipt_path(&root)).unwrap(), receipt_before);
            recover_acl_leases(installation_id, &root, false).unwrap();
            fs::remove_dir_all(&parent).unwrap();
            assert!(
                !stale_remains,
                "verification must recover the dead lease before applying ACLs: {error}"
            );
            assert!(
                error.contains("create AppContainer process"),
                "must reach the controlled invalid executable: {error}"
            );
        }

        #[test]
        fn verified_journal_blocks_launch_and_repairs_by_rolling_back_not_committing() {
            let installation_id = "aabbccddeeff001122334455";
            let parent = unique_test_root("verified-r-recovery");
            let root = parent.join(installation_id);
            let request_root = root.to_string_lossy();
            prepare_setup(installation_id, &request_root).unwrap();
            let mut previous = read_record(&journal_path(&root)).unwrap().unwrap();
            previous.state = OwnershipState::Owned;
            write_new_record(&receipt_path(&root), &previous).unwrap();
            fs::remove_file(journal_path(&root)).unwrap();
            let receipt_before = fs::read(receipt_path(&root)).unwrap();
            let home = parent.join("R");
            for directory in ["bin", "etc", "library"] {
                fs::create_dir_all(home.join(directory)).unwrap();
            }
            let executable = home.join("bin/Rscript.exe");
            fs::write(&executable, b"never executed").unwrap();
            prepare_runtime_access(
                installation_id,
                &request_root,
                &executable.to_string_lossy(),
                false,
                true,
            )
            .unwrap();
            let pending = read_record(&journal_path(&root)).unwrap().unwrap();
            assert_eq!(pending.schema_version, 6);
            assert!(pending.pending_runtime_access.is_some());
            validate_record(&pending, installation_id).unwrap();
            let mut invalid_completed = pending.clone();
            invalid_completed.state = OwnershipState::Owned;
            assert!(validate_record(&invalid_completed, installation_id).is_err());
            let spec = LaunchSpec {
                executable: executable.to_string_lossy().into_owned(),
                arguments: vec![
                    "--vanilla".into(),
                    "-e".into(),
                    R_VERIFICATION_SCRIPT.into(),
                ],
                verbatim_arguments: false,
                cwd: parent.to_string_lossy().into_owned(),
                read_only_roots: vec![],
                read_write_roots: vec![],
                denied_read_roots: vec![],
                denied_write_roots: vec![],
                termination_proof_path: None,
                termination_proof_token: None,
            };
            validate_runtime_verification(pending.pending_runtime_access.as_ref().unwrap(), &spec)
                .unwrap();
            assert!(
                format!(
                    "{:#}",
                    launch(installation_id, &request_root, spec).unwrap_err()
                )
                .contains("setup is incomplete")
            );
            // The elevated helper is live before its verification lease exists. Recovery must
            // not mistake that interval for an abandoned transaction.
            let transaction_name = wide(&format!("{OPERATION_MUTEX}.RAccess.{installation_id}"));
            let transaction = Handle(
                unsafe { CreateMutexW(None, true, PCWSTR(transaction_name.as_ptr())) }.unwrap(),
            );
            let repair_root = request_root.to_string();
            let concurrent_repair =
                std::thread::spawn(move || setup_network(installation_id, &repair_root))
                    .join()
                    .unwrap();
            unsafe { ReleaseMutex(transaction.0) }.unwrap();
            drop(transaction);
            assert!(
                concurrent_repair.is_err(),
                "repair must not roll back a live transaction before its lease starts"
            );
            assert!(journal_path(&root).exists());
            // Model a helper crash after only this owned fixture ancestor was changed. No OS or
            // user runtime path is granted by this test, and repair must keep the old receipt.
            let ancestor = parent.to_string_lossy();
            let original_acl = capture_acl_snapshot(&ancestor).unwrap();
            super::super::directory_access::update(&ancestor, &pending.profile_sid, true, false)
                .unwrap();
            assert!(cancel_setup(installation_id, &request_root).is_err());
            setup_network(installation_id, &request_root).unwrap();
            assert!(!journal_path(&root).exists());
            assert_eq!(fs::read(receipt_path(&root)).unwrap(), receipt_before);
            assert_eq!(capture_acl_snapshot(&ancestor).unwrap(), original_acl);
            fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn cancellation_while_waiting_for_commit_lock_preserves_previous_receipt() {
            use std::os::windows::process::CommandExt;
            let installation_id = "abcdabcdabcdabcdabcdabcd";
            let parent = unique_test_root("verification-cancel-at-commit");
            let root = parent.join(installation_id);
            prepare_setup(installation_id, &root.to_string_lossy()).unwrap();
            let mut previous = read_record(&journal_path(&root)).unwrap().unwrap();
            previous.state = OwnershipState::Owned;
            write_new_record(&receipt_path(&root), &previous).unwrap();
            fs::remove_file(journal_path(&root)).unwrap();
            let original = fs::read(receipt_path(&root)).unwrap();
            let home = parent.join("R");
            for directory in ["bin", "etc", "library"] {
                fs::create_dir_all(home.join(directory)).unwrap();
            }
            let executable = home.join("bin/Rscript.exe");
            fs::write(&executable, b"never executed").unwrap();
            prepare_runtime_access(
                installation_id,
                &root.to_string_lossy(),
                &executable.to_string_lossy(),
                false,
                true,
            )
            .unwrap();
            let pending = read_record(&journal_path(&root)).unwrap().unwrap();
            let mut verifier = Command::new("powershell.exe")
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
            let verifier_handle = verifier.as_raw_handle() as usize;
            let owner = Handle(
                unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, GetCurrentProcessId()) }.unwrap(),
            );
            let owner_handle = owner.0.0 as usize;
            let held_lock = OperationLock::acquire(installation_id).unwrap();
            let finish_root = root.clone();
            let (started, waiting) = std::sync::mpsc::channel();
            let completion = std::thread::spawn(move || {
                started.send(()).unwrap();
                complete_runtime_verification(
                    installation_id,
                    &finish_root,
                    pending,
                    &previous,
                    Ok(()),
                    HANDLE(verifier_handle as *mut _),
                    HANDLE(owner_handle as *mut _),
                )
            });
            waiting.recv().unwrap();
            verifier.kill().unwrap();
            verifier.wait().unwrap();
            drop(held_lock);
            let result = completion.join().unwrap();
            let receipt_after = fs::read(receipt_path(&root)).unwrap();
            fs::remove_dir_all(&parent).unwrap();
            assert!(
                result.is_err(),
                "a verifier cancelled before commit must not leave a successful authorization"
            );
            assert_eq!(receipt_after, original);
        }

        #[test]
        fn verified_journal_requires_a_valid_owned_verifier_lease_identity() {
            let installation_id = "123412341234123412341234";
            let parent = unique_test_root("verification-schema");
            let root = parent.join(installation_id);
            prepare_setup(installation_id, &root.to_string_lossy()).unwrap();
            let mut record = read_record(&journal_path(&root)).unwrap().unwrap();
            record.schema_version = 6;
            assert!(validate_record(&record, installation_id).is_err());
            record.pending_runtime_access = Some(PendingRuntimeAccess {
                executable: "unowned.exe".into(),
                lease_id: "../other".into(),
            });
            assert!(validate_record(&record, installation_id).is_err());
            record.schema_version = 4;
            assert!(validate_record(&record, installation_id).is_err());
            fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn waiting_for_uac_ends_when_the_initiating_process_exits() {
            use std::os::windows::process::CommandExt;
            let mut owner = Command::new("powershell.exe")
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .creation_flags(0x08000000)
                .spawn()
                .unwrap();
            let owner_pid = owner.id();
            let stop = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                owner.kill().unwrap();
                owner.wait().unwrap();
            });
            let started = Instant::now();
            let ticket =
                format!("{}{}", new_lease_id().unwrap(), new_lease_id().unwrap()).replace('-', "");
            let result = verify_runtime_access(
                "unused",
                "unused",
                &ticket,
                owner_pid,
                LaunchSpec {
                    executable: "never-launched".into(),
                    arguments: vec![],
                    verbatim_arguments: false,
                    cwd: "unused".into(),
                    read_only_roots: vec![],
                    read_write_roots: vec![],
                    denied_read_roots: vec![],
                    denied_write_roots: vec![],
                    termination_proof_path: None,
                    termination_proof_token: None,
                },
            );
            stop.join().unwrap();
            assert!(format!("{:#}", result.unwrap_err()).contains("R authorization owner exited"));
            assert!(started.elapsed() < Duration::from_secs(10));
        }

        #[test]
        fn timed_out_probe_proves_job_termination_before_returning_failure() {
            let root = unique_test_root("r-timeout-proof");
            fs::create_dir_all(&root).unwrap();
            let proof = root.join("terminated.proof");
            let spec = LaunchSpec {
                executable: std::env::var("ComSpec").unwrap(),
                arguments: vec!["/d".into(), "/c".into(), "ping -n 30 127.0.0.1 >NUL".into()],
                verbatim_arguments: false,
                cwd: root.to_string_lossy().into_owned(),
                read_only_roots: vec![],
                read_write_roots: vec![],
                denied_read_roots: vec![],
                denied_write_roots: vec![],
                termination_proof_path: Some(proof.to_string_lossy().into_owned()),
                termination_proof_token: Some("owned-timeout-proof".into()),
            };
            let startup = STARTUPINFOW {
                cb: size_of::<STARTUPINFOW>() as u32,
                ..Default::default()
            };
            let mut command = wide(&command_line(&spec));
            let cwd = wide(&spec.cwd);
            let mut info = PROCESS_INFORMATION::default();
            unsafe {
                CreateProcessW(
                    PCWSTR::null(),
                    Some(PWSTR(command.as_mut_ptr())),
                    None,
                    None,
                    false,
                    CREATE_SUSPENDED,
                    None,
                    PCWSTR(cwd.as_ptr()),
                    &startup,
                    &mut info,
                )
            }
            .unwrap();
            let process = Handle(info.hProcess);
            let thread = Handle(info.hThread);
            let mut terminate = TerminateOnDrop {
                process: process.0,
                armed: true,
            };
            let started = Instant::now();
            let result =
                run_suspended_process_in_job(&spec, &process, &thread, &mut terminate, None, 100);
            let proof_value = fs::read_to_string(&proof).ok();
            assert!(format!("{:#}", result.unwrap_err()).contains("R verification timed out"));
            assert!(started.elapsed() < Duration::from_secs(5));
            assert_eq!(proof_value.as_deref(), Some("owned-timeout-proof"));
            drop(terminate);
            drop(thread);
            drop(process);
            // CI can briefly retain a sharing lock after termination. Keep this cleanup grace
            // separate from the process-termination assertions and bounded to this test root.
            let cleanup_deadline = Instant::now() + Duration::from_secs(1);
            loop {
                match fs::remove_dir_all(&root) {
                    Ok(()) => break,
                    Err(error)
                        if error.raw_os_error() == Some(32)
                            && Instant::now() < cleanup_deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("remove timeout test directory: {error}"),
                }
            }
        }

        #[test]
        fn zero_exit_without_completed_r_probe_is_rejected() {
            use std::os::windows::process::CommandExt;
            let result = run_completed_r_probe(|writer| {
                let status = Command::new("cmd.exe")
                    .args(["/d", "/c", "exit 0"])
                    .stdout(writer)
                    .creation_flags(0x08000000)
                    .status()?;
                Ok(status.code().unwrap() as u32)
            });
            assert!(
                result.is_err(),
                "exit 0 without the completion marker must not authorize R"
            );
        }

        #[test]
        fn completed_r_probe_requires_success_and_drains_output() {
            use std::os::windows::process::CommandExt;
            for (script, expected) in [
                (
                    "[Console]::Write(('x' * 1100000)); [Console]::Write('OPEN_SCIENCE_R_ACCESS_OK'); exit 0",
                    0,
                ),
                ("[Console]::Write('OPEN_SCIENCE_R_ACCESS_OK'); exit 7", 7),
            ] {
                let result = run_completed_r_probe(|writer| {
                    let status = Command::new("powershell.exe")
                        .args([
                            "-NoLogo",
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            script,
                        ])
                        .stdout(writer)
                        .creation_flags(0x08000000)
                        .status()?;
                    Ok(status.code().unwrap() as u32)
                });
                assert_eq!(result.unwrap(), expected);
            }
        }

        #[test]
        fn foreign_verification_client_is_rejected_before_permission_changes() {
            use std::os::windows::process::CommandExt;
            let installation_id = "987698769876987698769876";
            let parent = unique_test_root("foreign-verifier");
            let root = parent.join(installation_id);
            prepare_setup(installation_id, &root.to_string_lossy()).unwrap();
            let journal_before = fs::read(journal_path(&root)).unwrap();
            let mut previous = read_record(&journal_path(&root)).unwrap().unwrap();
            previous.state = OwnershipState::Owned;
            write_new_record(&receipt_path(&root), &previous).unwrap();
            let receipt_before = fs::read(receipt_path(&root)).unwrap();
            let acl_before = capture_acl_snapshot(&parent.to_string_lossy()).unwrap();
            let ticket =
                format!("{}{}", new_lease_id().unwrap(), new_lease_id().unwrap()).replace('-', "");
            let server_ticket = ticket.clone();
            let server_root = root.clone();
            let expected_pid = unsafe { GetCurrentProcessId() };
            let server = std::thread::spawn(move || {
                authorize_runtime_access(
                    installation_id,
                    &server_root.to_string_lossy(),
                    &server_ticket,
                    expected_pid,
                    expected_pid,
                )
            });
            let script = format!(
                "$p = [System.IO.Pipes.NamedPipeClientStream]::new('.', 'LOCAL\\OpenScience.RAccess.{ticket}', [System.IO.Pipes.PipeDirection]::InOut); $p.Connect(10000); $null = $p.ReadByte(); $p.Dispose()"
            );
            let foreign = Command::new("powershell.exe")
                .args([
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &script,
                ])
                .creation_flags(0x08000000)
                .status()
                .unwrap();
            let error = format!("{:#}", server.join().unwrap().unwrap_err());
            assert!(foreign.success());
            assert!(
                error.contains("Unexpected R verification client"),
                "{error}"
            );
            assert_eq!(fs::read(journal_path(&root)).unwrap(), journal_before);
            assert_eq!(fs::read(receipt_path(&root)).unwrap(), receipt_before);
            assert_eq!(
                capture_acl_snapshot(&parent.to_string_lossy()).unwrap(),
                acl_before
            );
            fs::remove_dir_all(&parent).unwrap();
        }

        #[test]
        fn verification_pipe_has_one_server_and_bounds_control_messages() {
            let ticket =
                format!("{}{}", new_lease_id().unwrap(), new_lease_id().unwrap()).replace('-', "");
            let verifier = Handle(
                unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        GetCurrentProcessId(),
                    )
                }
                .unwrap(),
            );
            let mut server = create_verification_pipe(&ticket, verifier.0).unwrap();
            assert!(create_verification_pipe(&ticket, verifier.0).is_err());
            let name = wide(&verification_pipe_name(&ticket).unwrap());
            let client = unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_MODE(0),
                    None,
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    None,
                )
            }
            .unwrap();
            let mut client = unsafe { fs::File::from_raw_handle(client.0) };
            let mut client_pid = 0;
            unsafe { GetNamedPipeClientProcessId(pipe_handle(&server), &mut client_pid) }.unwrap();
            assert_eq!(client_pid, unsafe { GetCurrentProcessId() });
            client.write_all(b"rollback\n").unwrap();
            assert_eq!(
                read_verification_message(&mut server, || true).unwrap(),
                "rollback"
            );
            client.write_all(b"arbitrary-elevated-command\n").unwrap();
            assert!(
                format!(
                    "{:#}",
                    read_verification_message(&mut server, || true).unwrap_err()
                )
                .contains("Oversized")
            );
            assert!(verification_pipe_name("../../other").is_err());
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
        Some(
            command @ ("prepare-runtime-access"
            | "prepare-verified-runtime-access"
            | "prepare-remove-runtime-access"
            | "runtime-access-status"),
        ) => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            let executable = args.next().context("missing selected R interpreter")?;
            if args.next().is_some() {
                bail!("unexpected runtime-access argument");
            }
            if command == "runtime-access-status" {
                windows_host::runtime_access_status(
                    &installation_id,
                    &ownership_root,
                    &executable,
                )?;
            } else {
                windows_host::prepare_runtime_access(
                    &installation_id,
                    &ownership_root,
                    &executable,
                    command == "prepare-remove-runtime-access",
                    command == "prepare-verified-runtime-access",
                )?;
            }
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
        Some("authorize-runtime-access") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            let ticket = args.next().context("missing verification connection")?;
            let verifier = args.next().context("missing verifier process")?.parse()?;
            let owner = args.next().context("missing owner process")?.parse()?;
            if args.next().is_some() {
                bail!("unexpected verified authorization argument");
            }
            windows_host::authorize_runtime_access(
                &installation_id,
                &ownership_root,
                &ticket,
                verifier,
                owner,
            )?;
            Ok(0)
        }
        Some("verify-runtime-access") => {
            let installation_id = args.next().context("missing installation identity")?;
            let ownership_root = args.next().context("missing ownership root")?;
            let ticket = args.next().context("missing verification connection")?;
            let owner = args.next().context("missing verification owner")?.parse()?;
            let encoded = args.next().context("missing verification specification")?;
            if args.next().is_some() {
                bail!("unexpected runtime verification argument");
            }
            Ok(windows_host::verify_runtime_access(
                &installation_id,
                &ownership_root,
                &ticket,
                owner,
                decode_launch_spec(&encoded)?,
            )? as i32)
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
        Some("supervise") => {
            let encoded = args.next().context("missing launch specification")?;
            if args.next().is_some() {
                bail!("unexpected supervise argument");
            }
            Ok(windows_host::supervise(decode_launch_spec(&encoded)?)? as i32)
        }
        _ => bail!(
            "usage: notebook-appcontainer-host <status|prepare-setup|cancel-setup|setup|finish-setup|prepare-remove|remove|finish-remove INSTALLATION_ID OWNERSHIP_ROOT|launch INSTALLATION_ID OWNERSHIP_ROOT SPEC|supervise SPEC>"
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
            verbatim_arguments: false,
            cwd: "C:\\workspace".into(),
            read_only_roots: Vec::new(),
            read_write_roots: Vec::new(),
            denied_read_roots: Vec::new(),
            denied_write_roots: Vec::new(),
            termination_proof_path: None,
            termination_proof_token: None,
        };
        assert_eq!(
            command_line(&spec),
            "\"C:\\Program Files\\PowerShell\\pwsh.exe\" -Command \"Write-Output \\\"hello\\\"\\\\\""
        );
    }

    #[test]
    fn windows_command_line_preserves_pre_escaped_batch_arguments() {
        let spec = LaunchSpec {
            executable: "C:\\Windows\\System32\\cmd.exe".into(),
            arguments: vec![
                "/d".into(),
                "/s".into(),
                "/c".into(),
                "\"C:\\runtime^ path\\python.cmd ^\"C:\\app^ path\\loop.py^\"\"".into(),
            ],
            verbatim_arguments: true,
            cwd: "C:\\workspace".into(),
            read_only_roots: Vec::new(),
            read_write_roots: Vec::new(),
            denied_read_roots: Vec::new(),
            denied_write_roots: Vec::new(),
            termination_proof_path: None,
            termination_proof_token: None,
        };
        assert_eq!(
            command_line(&spec),
            "C:\\Windows\\System32\\cmd.exe /d /s /c \"C:\\runtime^ path\\python.cmd ^\"C:\\app^ path\\loop.py^\"\""
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
            verbatim_arguments: false,
            cwd: workspace.to_string_lossy().into_owned(),
            read_only_roots: Vec::new(),
            read_write_roots: vec![workspace.to_string_lossy().into_owned()],
            denied_read_roots: Vec::new(),
            denied_write_roots: vec![git.to_string_lossy().into_owned()],
            termination_proof_path: None,
            termination_proof_token: None,
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
