/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! A Touch ID platform authenticator for builds without Apple's passkey
//! entitlement.
//!
//! macOS only lets browsers signed with the restricted
//! `com.apple.developer.web-browser.public-key-credential` entitlement use its
//! passkey APIs. Touch ID and the login keychain are open to every app, so
//! this module implements a CTAP2 authenticator in software:
//!
//! - Every registration and sign-in shows the system Touch ID sheet (with the
//!   Mac password as fallback) before a private key is touched.
//! - Credentials live in `<profile>/zen-passkeys.json`. Site and account names
//!   are stored in the clear so requests can be routed without unlocking
//!   anything; private keys and user handles are AES-GCM encrypted with a key
//!   kept in the macOS keychain (see zen/passkeys/ZenPasskeysNative.mm).
//!
//! Keys are software keys, not Secure Enclave keys, so this is weaker than
//! Apple's passkeys against malware running as the user, but much stronger
//! than a password. Credentials are not synced.

use authenticator::authenticatorservice::{RegisterArgs, SignArgs};
use authenticator::ctap2::server::PublicKeyCredentialDescriptor;
use authenticator::errors::AuthenticatorError;
use authenticator::statecallback::StateCallback;
use authenticator::{RegisterResult, SignResult, StatusUpdate};
use std::sync::mpsc::Sender;

/// Platform-independent entry points used by lib.rs. Everything is a no-op
/// outside macOS.
pub(crate) struct ZenTouchId {
    #[cfg(target_os = "macos")]
    inner: imp::Manager,
}

impl ZenTouchId {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            inner: imp::Manager::new(),
        }
    }

    /// Any thread. Whether Touch ID passkeys are turned on.
    pub fn enabled(&self) -> bool {
        #[cfg(target_os = "macos")]
        return self.inner.enabled();
        #[cfg(not(target_os = "macos"))]
        return false;
    }

    /// Main thread. Whether a sign-in request can be answered by one of our
    /// credentials. Requests we cannot answer go to security keys instead.
    pub fn can_sign(&self, rp_id: &str, allow_list: &[PublicKeyCredentialDescriptor]) -> bool {
        #[cfg(target_os = "macos")]
        return self.enabled() && self.inner.has_credentials(rp_id, allow_list);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (rp_id, allow_list);
            false
        }
    }

    /// Main thread. Wraps the transaction's status channel so security-key
    /// prompts ("touch your security key") never appear for Touch ID, while
    /// account selection still reaches the browser UI.
    pub fn filter_status(&self, status: Sender<StatusUpdate>) -> Sender<StatusUpdate> {
        #[cfg(target_os = "macos")]
        return imp::filter_status(status);
        #[cfg(not(target_os = "macos"))]
        return status;
    }

    pub fn register(
        &self,
        args: RegisterArgs,
        status: Sender<StatusUpdate>,
        callback: StateCallback<Result<RegisterResult, AuthenticatorError>>,
    ) {
        #[cfg(target_os = "macos")]
        self.inner.register(args, status, callback);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (args, status);
            callback.call(Err(AuthenticatorError::Platform));
        }
    }

    pub fn sign(
        &self,
        args: SignArgs,
        status: Sender<StatusUpdate>,
        callback: StateCallback<Result<SignResult, AuthenticatorError>>,
    ) {
        #[cfg(target_os = "macos")]
        self.inner.sign(args, status, callback);
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (args, status);
            callback.call(Err(AuthenticatorError::Platform));
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use authenticator::crypto::{ecdsa_p256_sha256_sign_raw, COSEAlgorithm, COSEKey, SharedSecret};
    use authenticator::ctap2::{
        attestation::{
            AAGuid, AttestationObject, AttestationStatement, AttestedCredentialData,
            AuthenticatorData, AuthenticatorDataFlags, Extension,
        },
        commands::{
            client_pin::{ClientPIN, ClientPinResponse},
            credential_management::{CredentialManagement, CredentialManagementResponse},
            get_assertion::{GetAssertion, GetAssertionResponse, GetAssertionResult},
            get_info::{AuthenticatorInfo, AuthenticatorOptions, AuthenticatorVersion},
            get_version::{GetVersion, U2FInfo},
            make_credentials::{MakeCredentials, MakeCredentialsResult},
            reset::Reset,
            selection::Selection,
            RequestCtap1, RequestCtap2, StatusCode,
        },
        preflight::CheckKeyHandle,
        server::{AuthenticatorAttachment, PublicKeyCredentialUserEntity, RelyingParty},
    };
    use authenticator::errors::{CommandError, HIDError, U2FTokenError};
    use authenticator::{
        ctap2, CtapVersionSupport, FidoDevice, FidoDeviceIO, FidoProtocol, VirtualFidoDevice,
    };
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use base64::Engine;
    use moz_task::RunnableBuilder;
    use nserror::nsresult;
    use nsstring::{nsACString, nsCString};
    use rand::{thread_rng, RngCore};
    use serde::{Deserialize, Serialize};
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::channel;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    extern "C" {
        fn zen_passkeys_enabled() -> bool;
        fn zen_passkeys_prepare(path: *mut nsACString) -> nsresult;
        fn zen_passkeys_user_verify(reason: *const nsACString) -> bool;
        fn zen_passkeys_encrypt(plain: *const nsACString, out: *mut nsACString) -> nsresult;
        fn zen_passkeys_decrypt(cipher: *const nsACString, out: *mut nsACString) -> nsresult;
    }

    // Identifies credentials made by this authenticator. Randomly generated.
    const ZEN_TOUCHID_AAGUID: AAGuid = AAGuid([
        0x5a, 0x45, 0x4e, 0x7c, 0x9d, 0x31, 0x4b, 0x52, 0x86, 0x0f, 0xd1, 0x2e, 0x63, 0xb4, 0x07,
        0xa8,
    ]);

    const STORE_VERSION: u32 = 1;

    fn not_allowed() -> HIDError {
        HIDError::Command(CommandError::StatusCode(StatusCode::NotAllowed, None))
    }

    fn status_error(code: StatusCode) -> HIDError {
        HIDError::Command(CommandError::StatusCode(code, None))
    }

    // -----------------------------------------------------------------------
    // Storage

    #[derive(Serialize, Deserialize, Clone, Debug)]
    #[serde(rename_all = "camelCase")]
    struct CredentialMeta {
        /// base64url credential ID.
        id: String,
        rp_id: String,
        user_name: String,
        created: u64,
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CredentialSecret {
        /// base64 private key, in the format COSEKey::generate returns.
        private_key: String,
        /// base64 user handle chosen by the site.
        user_handle: String,
    }

    #[derive(Serialize, Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct StoreFile {
        version: u32,
        credentials: Vec<CredentialMeta>,
        /// zen_passkeys_encrypt(JSON map of credential ID -> CredentialSecret).
        #[serde(default)]
        secrets: String,
    }

    fn read_store(path: &Path) -> StoreFile {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                log::warn!("zen-passkeys: unreadable store, ignoring it: {e}");
                StoreFile::default()
            }),
            Err(_) => StoreFile::default(),
        }
    }

    fn write_store(path: &Path, store: &StoreFile) -> Result<(), HIDError> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let json = serde_json::to_vec_pretty(store).map_err(|_| HIDError::DeviceError)?;
        let tmp = path.with_extension("json.tmp");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|_| HIDError::DeviceError)?;
        file.write_all(&json).map_err(|_| HIDError::DeviceError)?;
        file.sync_all().map_err(|_| HIDError::DeviceError)?;
        fs::rename(&tmp, path).map_err(|_| HIDError::DeviceError)
    }

    fn decrypt_secrets(store: &StoreFile) -> Result<HashMap<String, CredentialSecret>, HIDError> {
        if store.secrets.is_empty() {
            return Ok(HashMap::new());
        }
        let cipher = nsCString::from(store.secrets.as_str());
        let mut plain = nsCString::new();
        unsafe { zen_passkeys_decrypt(&*cipher, &mut *plain) }
            .to_result()
            .map_err(|_| {
                // Usually the keychain item was deleted or access was refused.
                log::error!("zen-passkeys: could not decrypt stored keys");
                HIDError::DeviceError
            })?;
        serde_json::from_slice(&plain[..]).map_err(|_| HIDError::DeviceError)
    }

    fn encrypt_secrets(secrets: &HashMap<String, CredentialSecret>) -> Result<String, HIDError> {
        let json = serde_json::to_vec(secrets).map_err(|_| HIDError::DeviceError)?;
        let plain = nsCString::from(&json[..]);
        let mut cipher = nsCString::new();
        unsafe { zen_passkeys_encrypt(&*plain, &mut *cipher) }
            .to_result()
            .map_err(|_| HIDError::DeviceError)?;
        Ok(cipher.to_string())
    }

    fn user_verify(reason: &str) -> bool {
        let reason = nsCString::from(reason);
        unsafe { zen_passkeys_user_verify(&*reason) }
    }

    // -----------------------------------------------------------------------
    // Manager: routing and threading

    pub(super) struct Manager {
        path: Mutex<Option<PathBuf>>,
    }

    impl Manager {
        pub fn new() -> Self {
            Self {
                path: Mutex::new(None),
            }
        }

        /// Any thread.
        pub fn enabled(&self) -> bool {
            unsafe { zen_passkeys_enabled() }
        }

        /// Main thread: the store path, preparing the key store on first use.
        fn path(&self) -> Option<PathBuf> {
            let mut guard = self.path.lock().unwrap();
            if guard.is_none() {
                let mut path = nsCString::new();
                if unsafe { zen_passkeys_prepare(&mut *path) }
                    .to_result()
                    .is_ok()
                {
                    *guard = Some(PathBuf::from(path.to_string()));
                }
            }
            guard.clone()
        }

        pub fn has_credentials(
            &self,
            rp_id: &str,
            allow_list: &[PublicKeyCredentialDescriptor],
        ) -> bool {
            let Some(path) = self.path() else {
                return false;
            };
            let store = read_store(&path);
            store.credentials.iter().any(|c| {
                c.rp_id == rp_id
                    && (allow_list.is_empty()
                        || allow_list
                            .iter()
                            .any(|d| URL_SAFE_NO_PAD.encode(&d.id) == c.id))
            })
        }

        pub fn register(
            &self,
            args: RegisterArgs,
            status: Sender<StatusUpdate>,
            callback: StateCallback<Result<RegisterResult, AuthenticatorError>>,
        ) {
            let Some(path) = self.path() else {
                callback.call(Err(AuthenticatorError::Platform));
                return;
            };
            let fallback = callback.clone();
            let task = RunnableBuilder::new("ZenTouchId::register", move || {
                let mut device = TouchIdDevice::new(path);
                if device.init().is_err() {
                    callback.call(Err(AuthenticatorError::Platform));
                    return;
                }
                if !ctap2::register(&mut device, args, status, callback.clone(), &|| true) {
                    // No-op if ctap2::register already reported an error.
                    callback.call(Err(AuthenticatorError::U2FToken(U2FTokenError::NotAllowed)));
                }
            })
            .may_block(true)
            .dispatch_background_task();
            if task.is_err() {
                fallback.call(Err(AuthenticatorError::Platform));
            }
        }

        pub fn sign(
            &self,
            args: SignArgs,
            status: Sender<StatusUpdate>,
            callback: StateCallback<Result<SignResult, AuthenticatorError>>,
        ) {
            let Some(path) = self.path() else {
                callback.call(Err(AuthenticatorError::Platform));
                return;
            };
            let fallback = callback.clone();
            let task = RunnableBuilder::new("ZenTouchId::sign", move || {
                let mut device = TouchIdDevice::new(path);
                if device.init().is_err() {
                    callback.call(Err(AuthenticatorError::Platform));
                    return;
                }
                if !ctap2::sign(&mut device, args, status, callback.clone(), &|| true) {
                    callback.call(Err(AuthenticatorError::U2FToken(U2FTokenError::NotAllowed)));
                }
            })
            .may_block(true)
            .dispatch_background_task();
            if task.is_err() {
                fallback.call(Err(AuthenticatorError::Platform));
            }
        }
    }

    pub(super) fn filter_status(downstream: Sender<StatusUpdate>) -> Sender<StatusUpdate> {
        let (tx, rx) = channel::<StatusUpdate>();
        let _ = RunnableBuilder::new("ZenTouchId::StatusFilter", move || {
            while let Ok(update) = rx.recv() {
                match update {
                    // Touch ID shows its own system sheet.
                    StatusUpdate::PresenceRequired | StatusUpdate::SelectDeviceNotice => {}
                    other => {
                        if downstream.send(other).is_err() {
                            break;
                        }
                    }
                }
            }
        })
        .may_block(true)
        .dispatch_background_task();
        tx
    }

    // -----------------------------------------------------------------------
    // The virtual CTAP2 device. One is created per request, on a background
    // thread, so blocking on the Touch ID sheet is fine.

    struct TouchIdDevice {
        path: PathBuf,
        store: RefCell<StoreFile>,
        verified: Cell<bool>,
        protocol: FidoProtocol,
        shared_secret: Option<SharedSecret>,
        authenticator_info: Option<AuthenticatorInfo>,
    }

    // Required by FidoDevice. Deliberately prints nothing about credentials.
    impl std::fmt::Debug for TouchIdDevice {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("TouchIdDevice")
        }
    }

    impl TouchIdDevice {
        fn new(path: PathBuf) -> Self {
            let store = read_store(&path);
            Self {
                path,
                store: RefCell::new(store),
                verified: Cell::new(false),
                protocol: FidoProtocol::CTAP2,
                shared_secret: None,
                authenticator_info: None,
            }
        }

        /// Shows Touch ID once per request.
        fn verify_user(&self, reason: &str) -> Result<(), HIDError> {
            if self.verified.get() {
                return Ok(());
            }
            if !user_verify(reason) {
                return Err(not_allowed());
            }
            self.verified.set(true);
            Ok(())
        }
    }

    impl FidoDevice for TouchIdDevice {
        fn pre_init(&mut self) -> Result<(), HIDError> {
            Ok(())
        }
        fn should_try_ctap2(&self) -> bool {
            true
        }
        fn initialized(&self) -> bool {
            true
        }
        fn is_u2f(&mut self) -> bool {
            true
        }
        fn get_shared_secret(&self) -> Option<&SharedSecret> {
            self.shared_secret.as_ref()
        }
        fn set_shared_secret(&mut self, shared_secret: SharedSecret) {
            self.shared_secret = Some(shared_secret);
        }
        fn get_authenticator_info(&self) -> Option<&AuthenticatorInfo> {
            self.authenticator_info.as_ref()
        }
        fn set_authenticator_info(&mut self, authenticator_info: AuthenticatorInfo) {
            self.authenticator_info = Some(authenticator_info);
        }
        fn get_protocol(&self) -> FidoProtocol {
            self.protocol
        }
        fn downgrade_to_ctap1(&mut self) -> Result<(), HIDError> {
            Err(HIDError::UnexpectedVersion)
        }
    }

    impl CtapVersionSupport for TouchIdDevice {
        fn supports_ctap1(&self) -> bool {
            false
        }
        fn supports_ctap2(&self) -> bool {
            true
        }
    }

    impl FidoDeviceIO for TouchIdDevice {
        fn send_msg_cancellable<
            Out,
            Req: RequestCtap1<Output = Out> + RequestCtap2<Output = Out>,
        >(
            &mut self,
            msg: &Req,
            keep_alive: &dyn Fn() -> bool,
            status: Option<&Sender<StatusUpdate>>,
        ) -> Result<Out, HIDError> {
            self.send_cbor_cancellable(msg, keep_alive, status)
        }

        fn send_cbor_cancellable<Req: RequestCtap2>(
            &mut self,
            msg: &Req,
            _keep_alive: &dyn Fn() -> bool,
            _status: Option<&Sender<StatusUpdate>>,
        ) -> Result<Req::Output, HIDError> {
            msg.send_to_virtual_device(self)
        }

        fn send_ctap1_cancellable<Req: RequestCtap1>(
            &mut self,
            _msg: &Req,
            _keep_alive: &dyn Fn() -> bool,
            _status: Option<&Sender<StatusUpdate>>,
        ) -> Result<Req::Output, HIDError> {
            Err(HIDError::UnexpectedVersion)
        }
    }

    impl VirtualFidoDevice for TouchIdDevice {
        fn check_key_handle(&self, _req: &CheckKeyHandle) -> Result<(), HIDError> {
            Err(HIDError::UnsupportedCommand)
        }

        fn client_pin(&self, _req: &ClientPIN) -> Result<ClientPinResponse, HIDError> {
            // Touch ID is the only form of user verification; there is no PIN.
            Err(HIDError::UnsupportedCommand)
        }

        fn get_assertion(&self, req: &GetAssertion) -> Result<Vec<GetAssertionResult>, HIDError> {
            let rp_hash = req.rp.hash();
            let candidates: Vec<CredentialMeta> = self
                .store
                .borrow()
                .credentials
                .iter()
                .filter(|c| RelyingParty::from(c.rp_id.as_str()).hash() == rp_hash)
                .filter(|c| {
                    req.allow_list.is_empty()
                        || req
                            .allow_list
                            .iter()
                            .any(|d| URL_SAFE_NO_PAD.encode(&d.id) == c.id)
                })
                .cloned()
                .collect();
            if candidates.is_empty() {
                return Err(status_error(StatusCode::NoCredentials));
            }

            let up = req.options.user_presence.unwrap_or(true);
            let uv = req.options.user_verification.unwrap_or(false);
            let mut flags = AuthenticatorDataFlags::empty();
            let secrets = if up || uv {
                self.verify_user(&format!("sign in to {} with a passkey", req.rp.id))?;
                flags |=
                    AuthenticatorDataFlags::USER_PRESENT | AuthenticatorDataFlags::USER_VERIFIED;
                Some(decrypt_secrets(&self.store.borrow())?)
            } else {
                // Silent pre-flight check of which credentials exist: no prompt,
                // no keys decrypted, no signature.
                None
            };

            let mut results = vec![];
            for meta in candidates {
                let id = URL_SAFE_NO_PAD
                    .decode(&meta.id)
                    .map_err(|_| HIDError::DeviceError)?;
                let auth_data = AuthenticatorData {
                    rp_id_hash: rp_hash.clone(),
                    flags,
                    // Like Apple's passkeys, we do not keep a signature counter.
                    counter: 0,
                    credential_data: None,
                    extensions: Extension::default(),
                };
                let (signature, user_handle) = match &secrets {
                    Some(secrets) => {
                        let secret = secrets.get(&meta.id).ok_or(HIDError::DeviceError)?;
                        let key = STANDARD
                            .decode(&secret.private_key)
                            .map_err(|_| HIDError::DeviceError)?;
                        let mut data = auth_data.to_vec();
                        data.extend_from_slice(req.client_data_hash.as_ref());
                        let signature = ecdsa_p256_sha256_sign_raw(&key, &data)
                            .map_err(|_| HIDError::DeviceError)?;
                        let user = STANDARD
                            .decode(&secret.user_handle)
                            .map_err(|_| HIDError::DeviceError)?;
                        (signature, user)
                    }
                    None => (vec![], vec![]),
                };
                let assertion = GetAssertionResponse {
                    credentials: Some(PublicKeyCredentialDescriptor {
                        id,
                        transports: vec![],
                    }),
                    auth_data,
                    signature,
                    user: Some(PublicKeyCredentialUserEntity {
                        id: user_handle,
                        name: Some(meta.user_name.clone()),
                        display_name: None,
                    }),
                    number_of_credentials: Some(1),
                    user_selected: None,
                    large_blob_key: None,
                    unsigned_extension_outputs: None,
                    ep_attestation: None,
                    att_stmt: None,
                };
                results.push(GetAssertionResult {
                    assertion: assertion.into(),
                    attachment: AuthenticatorAttachment::Platform,
                    extensions: Default::default(),
                    user_selected: None,
                    large_blob_key: None,
                    large_blob_array: None,
                });
                if !req.allow_list.is_empty() {
                    // With an allow list, answer with a single credential.
                    break;
                }
            }
            Ok(results)
        }

        fn get_info(&self) -> Result<AuthenticatorInfo, HIDError> {
            Ok(AuthenticatorInfo {
                versions: vec![AuthenticatorVersion::FIDO_2_0],
                extensions: vec!["credProtect".to_string()],
                aaguid: ZEN_TOUCHID_AAGUID,
                options: AuthenticatorOptions {
                    platform_device: true,
                    resident_key: true,
                    // Built-in user verification (Touch ID), no PIN, no
                    // pinUvAuthToken: the client sends uv=true directly.
                    user_verification: Some(true),
                    client_pin: None,
                    pin_uv_auth_token: None,
                    ..Default::default()
                },
                transports: Some(vec!["internal".to_string()]),
                ..Default::default()
            })
        }

        fn get_version(&self, _req: &GetVersion) -> Result<U2FInfo, HIDError> {
            Err(HIDError::UnsupportedCommand)
        }

        fn make_credentials(
            &self,
            req: &MakeCredentials,
        ) -> Result<MakeCredentialsResult, HIDError> {
            if !req
                .pub_cred_params
                .iter()
                .any(|p| p.alg == COSEAlgorithm::ES256)
            {
                return Err(status_error(StatusCode::UnsupportedAlgorithm));
            }

            self.verify_user(&format!("create a passkey for {}", req.rp.id))?;

            let rp_hash = req.rp.hash();
            {
                let store = self.store.borrow();
                let excluded = req.exclude_list.iter().any(|d| {
                    let id = URL_SAFE_NO_PAD.encode(&d.id);
                    store.credentials.iter().any(|c| {
                        c.id == id && RelyingParty::from(c.rp_id.as_str()).hash() == rp_hash
                    })
                });
                if excluded {
                    return Err(status_error(StatusCode::CredentialExcluded));
                }
            }

            let (private, public) =
                COSEKey::generate(COSEAlgorithm::ES256).map_err(|_| HIDError::DeviceError)?;
            let mut id = [0u8; 32];
            thread_rng().fill_bytes(&mut id);
            let user = req.user.clone().unwrap_or_default();
            let id_text = URL_SAFE_NO_PAD.encode(id);

            // Decrypt existing keys before writing, so a keychain problem can
            // never overwrite (and lose) previously saved passkeys.
            {
                let mut store = self.store.borrow_mut();
                let mut secrets = decrypt_secrets(&store)?;
                secrets.insert(
                    id_text.clone(),
                    CredentialSecret {
                        private_key: STANDARD.encode(&private),
                        user_handle: STANDARD.encode(&user.id),
                    },
                );
                let created = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                store.version = STORE_VERSION;
                store.credentials.push(CredentialMeta {
                    id: id_text,
                    rp_id: req.rp.id.clone(),
                    user_name: user
                        .name
                        .clone()
                        .or(user.display_name.clone())
                        .unwrap_or_default(),
                    created,
                });
                store.secrets = encrypt_secrets(&secrets)?;
                write_store(&self.path, &store)?;
            }

            let mut extensions = Extension::default();
            extensions.cred_protect = req.extensions.cred_protect;
            let mut flags = AuthenticatorDataFlags::USER_PRESENT
                | AuthenticatorDataFlags::USER_VERIFIED
                | AuthenticatorDataFlags::ATTESTED;
            if extensions.has_some() {
                flags |= AuthenticatorDataFlags::EXTENSION_DATA;
            }

            Ok(MakeCredentialsResult {
                attachment: AuthenticatorAttachment::Platform,
                att_obj: AttestationObject {
                    // Like Apple's passkeys: no attestation.
                    att_stmt: AttestationStatement::None,
                    auth_data: AuthenticatorData {
                        rp_id_hash: rp_hash,
                        flags,
                        counter: 0,
                        credential_data: Some(AttestedCredentialData {
                            aaguid: ZEN_TOUCHID_AAGUID,
                            credential_id: id.to_vec(),
                            credential_public_key: public,
                        }),
                        extensions,
                    },
                },
                extensions: Default::default(),
                ep_attestation: None,
                large_blob_key: None,
                unsigned_extension_outputs: None,
            })
        }

        fn reset(&self, _req: &Reset) -> Result<(), HIDError> {
            Err(HIDError::UnsupportedCommand)
        }

        fn selection(&self, _req: &Selection) -> Result<(), HIDError> {
            Err(HIDError::UnsupportedCommand)
        }

        fn manage_credentials(
            &mut self,
            _req: &CredentialManagement,
        ) -> Result<CredentialManagementResponse, HIDError> {
            Err(HIDError::UnsupportedCommand)
        }
    }
}
