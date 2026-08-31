use std::ffi::c_void;

use anyhow::{Result, bail};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::WindowsFilteringPlatform::{
    FWP_ACTION_BLOCK, FWP_ACTION_PERMIT, FWP_BYTE_BLOB, FWP_CONDITION_VALUE0,
    FWP_CONDITION_VALUE0_0, FWP_MATCH_EQUAL, FWP_SID, FWP_UINT8, FWP_UINT16, FWP_UINT64,
    FWP_V4_ADDR_AND_MASK, FWP_V4_ADDR_MASK, FWP_VALUE0, FWP_VALUE0_0, FWPM_ACTION0,
    FWPM_CONDITION_ALE_PACKAGE_ID, FWPM_CONDITION_IP_PROTOCOL, FWPM_CONDITION_IP_REMOTE_ADDRESS,
    FWPM_CONDITION_IP_REMOTE_PORT, FWPM_DISPLAY_DATA0, FWPM_FILTER_CONDITION0,
    FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT, FWPM_FILTER_FLAG_PERSISTENT, FWPM_FILTER0,
    FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6, FWPM_SUBLAYER_FLAG_PERSISTENT,
    FWPM_SUBLAYER0, FwpmEngineClose0, FwpmEngineOpen0, FwpmFilterAdd0, FwpmFilterDeleteByKey0,
    FwpmFilterGetByKey0, FwpmFreeMemory0, FwpmSubLayerAdd0, FwpmSubLayerDeleteByKey0,
    FwpmSubLayerGetByKey0, FwpmTransactionAbort0, FwpmTransactionBegin0, FwpmTransactionCommit0,
};
use windows::Win32::Security::PSID;
use windows::core::{GUID, PCWSTR, PWSTR};

const RPC_C_AUTHN_DEFAULT: u32 = u32::MAX;
const FWP_E_FILTER_NOT_FOUND: u32 = 0x8032_0003;
const FWP_E_SUBLAYER_NOT_FOUND: u32 = 0x8032_0007;
const SUBLAYER_WEIGHT: u16 = 0x7000;
const PERMIT_WEIGHT: u64 = 0x0f00_0000_0000_0000;
const BLOCK_WEIGHT: u64 = 0x0e00_0000_0000_0000;
const FILTER_ROLES: [&str; 3] = ["permit-v4", "block-v4", "block-v6"];

pub struct FenceDescriptor<'a> {
    pub installation_id: &'a str,
    pub ownership_token: &'a str,
    pub sublayer_key: &'a str,
    pub filter_keys: &'a [String],
    pub gateway_port: u16,
}

struct Engine(HANDLE);

impl Engine {
    fn open() -> Result<Self> {
        let mut handle = HANDLE::default();
        let code = unsafe {
            FwpmEngineOpen0(PCWSTR::null(), RPC_C_AUTHN_DEFAULT, None, None, &mut handle)
        };
        check(code, "open Windows Filtering Platform engine")?;
        Ok(Self(handle))
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        unsafe {
            let _ = FwpmEngineClose0(self.0);
        }
    }
}

struct AbortTransaction(HANDLE);

impl Drop for AbortTransaction {
    fn drop(&mut self) {
        unsafe {
            let _ = FwpmTransactionAbort0(self.0);
        }
    }
}

struct WfpMemory<T>(*mut T);

impl<T> WfpMemory<T> {
    fn get(&self) -> &T {
        unsafe { &*self.0 }
    }
}

impl<T> Drop for WfpMemory<T> {
    fn drop(&mut self) {
        let mut pointer = self.0.cast::<c_void>();
        unsafe { FwpmFreeMemory0(&mut pointer) };
    }
}

fn check(code: u32, action: &str) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        bail!("{action}: Windows error 0x{code:08x}")
    }
}

fn with_transaction<T>(operation: impl FnOnce(HANDLE) -> Result<T>) -> Result<T> {
    let engine = Engine::open()?;
    check(
        unsafe { FwpmTransactionBegin0(engine.0, 0) },
        "begin Windows Filtering Platform transaction",
    )?;
    let abort = AbortTransaction(engine.0);
    let result = operation(engine.0)?;
    check(
        unsafe { FwpmTransactionCommit0(engine.0) },
        "commit Windows Filtering Platform transaction",
    )?;
    std::mem::forget(abort);
    Ok(result)
}

fn parse_guid(value: &str) -> Result<GUID> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid Windows Filtering Platform resource key");
    }
    Ok(GUID::from_u128(u128::from_str_radix(value, 16)?))
}

fn keys(descriptor: &FenceDescriptor<'_>) -> Result<(GUID, [GUID; 3])> {
    let sublayer = parse_guid(descriptor.sublayer_key)?;
    let filters = descriptor
        .filter_keys
        .iter()
        .map(|key| parse_guid(key))
        .collect::<Result<Vec<_>>>()?;
    let filters: [GUID; 3] = filters
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid Windows Filtering Platform filter key count"))?;
    let mut unique = vec![sublayer.to_u128()];
    unique.extend(filters.iter().map(GUID::to_u128));
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != 4 {
        bail!("Windows Filtering Platform resource keys must be unique");
    }
    Ok((sublayer, filters))
}

pub fn validate_keys(descriptor: &FenceDescriptor<'_>) -> Result<()> {
    keys(descriptor).map(|_| ())
}

fn tag(descriptor: &FenceDescriptor<'_>, role: &str) -> Vec<u8> {
    format!(
        "OpenScienceNotebook\0{}\0{}\0{}",
        descriptor.installation_id, descriptor.ownership_token, role
    )
    .into_bytes()
}

fn blob(bytes: &mut [u8]) -> FWP_BYTE_BLOB {
    FWP_BYTE_BLOB {
        size: bytes.len() as u32,
        data: bytes.as_mut_ptr(),
    }
}

fn owns_blob(actual: &FWP_BYTE_BLOB, expected: &[u8]) -> bool {
    if actual.size as usize != expected.len() || actual.data.is_null() {
        return false;
    }
    unsafe { std::slice::from_raw_parts(actual.data, actual.size as usize) == expected }
}

fn get_filter(engine: HANDLE, key: &GUID) -> Result<Option<WfpMemory<FWPM_FILTER0>>> {
    let mut pointer = std::ptr::null_mut();
    let code = unsafe { FwpmFilterGetByKey0(engine, key, &mut pointer) };
    if code == FWP_E_FILTER_NOT_FOUND {
        return Ok(None);
    }
    check(code, "read Windows Filtering Platform filter")?;
    Ok(Some(WfpMemory(pointer)))
}

fn get_sublayer(engine: HANDLE, key: &GUID) -> Result<Option<WfpMemory<FWPM_SUBLAYER0>>> {
    let mut pointer = std::ptr::null_mut();
    let code = unsafe { FwpmSubLayerGetByKey0(engine, key, &mut pointer) };
    if code == FWP_E_SUBLAYER_NOT_FOUND {
        return Ok(None);
    }
    check(code, "read Windows Filtering Platform sublayer")?;
    Ok(Some(WfpMemory(pointer)))
}

fn remove_owned_filter(
    engine: HANDLE,
    sublayer: &GUID,
    key: &GUID,
    expected_tag: &[u8],
) -> Result<()> {
    let Some(existing) = get_filter(engine, key)? else {
        return Ok(());
    };
    if existing.get().subLayerKey != *sublayer
        || !owns_blob(&existing.get().providerData, expected_tag)
    {
        bail!("preserving a Windows Filtering Platform filter not owned by this installation");
    }
    check(
        unsafe { FwpmFilterDeleteByKey0(engine, key) },
        "remove Windows Filtering Platform filter",
    )
}

fn ensure_sublayer(engine: HANDLE, descriptor: &FenceDescriptor<'_>, key: &GUID) -> Result<()> {
    let mut expected_tag = tag(descriptor, "sublayer");
    if let Some(existing) = get_sublayer(engine, key)? {
        if owns_blob(&existing.get().providerData, &expected_tag) {
            return Ok(());
        }
        bail!("preserving a Windows Filtering Platform sublayer not owned by this installation");
    }
    let mut name = "Open Science Notebook protection\0"
        .encode_utf16()
        .collect::<Vec<_>>();
    let mut description =
        "Restricts the owned Notebook AppContainer to its authenticated gateway\0"
            .encode_utf16()
            .collect::<Vec<_>>();
    let sublayer = FWPM_SUBLAYER0 {
        subLayerKey: *key,
        displayData: FWPM_DISPLAY_DATA0 {
            name: PWSTR(name.as_mut_ptr()),
            description: PWSTR(description.as_mut_ptr()),
        },
        flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
        providerKey: std::ptr::null_mut(),
        providerData: blob(&mut expected_tag),
        weight: SUBLAYER_WEIGHT,
    };
    check(
        unsafe { FwpmSubLayerAdd0(engine, &sublayer, None) },
        "add Windows Filtering Platform sublayer",
    )
}

enum FilterKind {
    PermitV4,
    BlockV4,
    BlockV6,
}

fn add_filter(
    engine: HANDLE,
    descriptor: &FenceDescriptor<'_>,
    sublayer: GUID,
    key: GUID,
    package_sid: PSID,
    role: &str,
    kind: FilterKind,
) -> Result<()> {
    let mut provider_tag = tag(descriptor, role);
    let sid_condition = FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_ALE_PACKAGE_ID,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_SID,
            Anonymous: FWP_CONDITION_VALUE0_0 {
                sid: package_sid.0.cast(),
            },
        },
    };
    let mut v4_loopback = FWP_V4_ADDR_AND_MASK {
        addr: 0x7f00_0001,
        mask: u32::MAX,
    };
    let mut address_condition = FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_IP_REMOTE_ADDRESS,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0::default(),
    };
    let port_condition = FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_IP_REMOTE_PORT,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_UINT16,
            Anonymous: FWP_CONDITION_VALUE0_0 {
                uint16: descriptor.gateway_port,
            },
        },
    };
    let protocol_condition = FWPM_FILTER_CONDITION0 {
        fieldKey: FWPM_CONDITION_IP_PROTOCOL,
        matchType: FWP_MATCH_EQUAL,
        conditionValue: FWP_CONDITION_VALUE0 {
            r#type: FWP_UINT8,
            Anonymous: FWP_CONDITION_VALUE0_0 { uint8: 6 },
        },
    };
    let (layer, action, weight, flags, conditions) = match kind {
        FilterKind::PermitV4 => {
            address_condition.conditionValue = FWP_CONDITION_VALUE0 {
                r#type: FWP_V4_ADDR_MASK,
                Anonymous: FWP_CONDITION_VALUE0_0 {
                    v4AddrMask: &mut v4_loopback,
                },
            };
            (
                FWPM_LAYER_ALE_AUTH_CONNECT_V4,
                FWP_ACTION_PERMIT,
                PERMIT_WEIGHT,
                FWPM_FILTER_FLAG_PERSISTENT,
                vec![
                    sid_condition,
                    address_condition,
                    port_condition,
                    protocol_condition,
                ],
            )
        }
        FilterKind::BlockV4 => (
            FWPM_LAYER_ALE_AUTH_CONNECT_V4,
            FWP_ACTION_BLOCK,
            BLOCK_WEIGHT,
            FWPM_FILTER_FLAG_PERSISTENT | FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT,
            vec![sid_condition],
        ),
        FilterKind::BlockV6 => (
            FWPM_LAYER_ALE_AUTH_CONNECT_V6,
            FWP_ACTION_BLOCK,
            BLOCK_WEIGHT,
            FWPM_FILTER_FLAG_PERSISTENT | FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT,
            vec![sid_condition],
        ),
    };
    let mut conditions = conditions;
    let mut weight_slot = weight;
    let mut name = format!("Open Science Notebook {role}\0")
        .encode_utf16()
        .collect::<Vec<_>>();
    let mut description = "Owned Notebook AppContainer network boundary\0"
        .encode_utf16()
        .collect::<Vec<_>>();
    let filter = FWPM_FILTER0 {
        filterKey: key,
        displayData: FWPM_DISPLAY_DATA0 {
            name: PWSTR(name.as_mut_ptr()),
            description: PWSTR(description.as_mut_ptr()),
        },
        flags,
        providerKey: std::ptr::null_mut(),
        providerData: blob(&mut provider_tag),
        layerKey: layer,
        subLayerKey: sublayer,
        weight: FWP_VALUE0 {
            r#type: FWP_UINT64,
            Anonymous: FWP_VALUE0_0 {
                uint64: &mut weight_slot,
            },
        },
        numFilterConditions: conditions.len() as u32,
        filterCondition: conditions.as_mut_ptr(),
        action: FWPM_ACTION0 {
            r#type: action,
            ..Default::default()
        },
        ..Default::default()
    };
    check(
        unsafe { FwpmFilterAdd0(engine, &filter, None, None) },
        "add Windows Filtering Platform filter",
    )
}

pub fn install(descriptor: &FenceDescriptor<'_>, package_sid: PSID) -> Result<()> {
    let (sublayer, filter_keys) = keys(descriptor)?;
    with_transaction(|engine| {
        ensure_sublayer(engine, descriptor, &sublayer)?;
        for ((key, role), kind) in filter_keys.iter().zip(FILTER_ROLES).zip([
            FilterKind::PermitV4,
            FilterKind::BlockV4,
            FilterKind::BlockV6,
        ]) {
            let expected_tag = tag(descriptor, role);
            remove_owned_filter(engine, &sublayer, key, &expected_tag)?;
            add_filter(engine, descriptor, sublayer, *key, package_sid, role, kind)?;
        }
        Ok(())
    })
}

pub fn remove(descriptor: &FenceDescriptor<'_>) -> Result<()> {
    let (sublayer, filter_keys) = keys(descriptor)?;
    with_transaction(|engine| {
        for (key, role) in filter_keys.iter().zip(FILTER_ROLES) {
            remove_owned_filter(engine, &sublayer, key, &tag(descriptor, role))?;
        }
        let expected_tag = tag(descriptor, "sublayer");
        if let Some(existing) = get_sublayer(engine, &sublayer)? {
            if !owns_blob(&existing.get().providerData, &expected_tag) {
                bail!(
                    "preserving a Windows Filtering Platform sublayer not owned by this installation"
                );
            }
            check(
                unsafe { FwpmSubLayerDeleteByKey0(engine, &sublayer) },
                "remove Windows Filtering Platform sublayer",
            )?;
        }
        Ok(())
    })
}
