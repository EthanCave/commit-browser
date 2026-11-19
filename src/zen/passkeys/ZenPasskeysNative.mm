/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Native helpers for the Touch ID passkey authenticator in
// dom/webauthn/authrs_bridge/src/zen_touchid.rs.
//
// macOS only lets browsers with Apple's restricted
// com.apple.developer.web-browser.public-key-credential entitlement use the
// system passkey APIs. Touch ID itself (LocalAuthentication) and the login
// keychain are open to every app, so we build on those instead:
//
// - zen_passkeys_user_verify shows the Touch ID / Mac password sheet.
// - zen_passkeys_encrypt / _decrypt protect private keys with an AES-GCM key
//   that lives in the macOS keychain, using the same OSKeyStore Firefox uses
//   for saved credit cards.

#include "OSKeyStore.h"
#include "OSReauthenticator.h"
#include "mozilla/Atomics.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPtr.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIFile.h"
#include "nsString.h"
#include "nsThreadUtils.h"

using namespace mozilla;

namespace {

// Shown in Keychain Access as the item holding the encryption key.
constexpr auto kKeyLabel = "Zen Passkeys"_ns;
constexpr auto kStoreFileName = u"zen-passkeys.json"_ns;
constexpr auto kEnabledPref = "zen.passkeys.touchid.enabled";

StaticRefPtr<OSKeyStore> sKeyStore;

// Last value of kEnabledPref seen on the main thread. Firefox asks whether a
// platform authenticator exists from a background thread, where prefs cannot
// be read.
Atomic<bool> sEnabled(true);

}  // namespace

extern "C" {

// Any thread. Whether the Touch ID authenticator should handle requests.
bool zen_passkeys_enabled() {
  if (NS_IsMainThread()) {
    sEnabled = Preferences::GetBool(kEnabledPref, true);
  }
  return sEnabled;
}

// Main thread. Writes the path of the credential store into aPath and makes
// sure the key store is ready for use from background threads.
nsresult zen_passkeys_prepare(nsACString* aPath) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!NS_IsMainThread() || !aPath) {
    return NS_ERROR_FAILURE;
  }
  if (!sKeyStore) {
    sKeyStore = OSKeyStore::GetSingleton();
    if (!sKeyStore) {
      return NS_ERROR_NOT_AVAILABLE;
    }
    ClearOnShutdown(&sKeyStore);
  }
  nsCOMPtr<nsIFile> file;
  nsresult rv =
      NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR, getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);
  rv = file->Append(kStoreFileName);
  NS_ENSURE_SUCCESS(rv, rv);
  return file->GetNativePath(*aPath);
}

// Background thread only: blocks until the user answers the system sheet.
// Returns true when Touch ID (or the Mac login password) was accepted.
bool zen_passkeys_user_verify(const nsACString* aReason) {
  MOZ_ASSERT(!NS_IsMainThread());
  if (NS_IsMainThread() || !aReason) {
    return false;
  }
  bool verified = false;
  bool blankPassword = false;
  nsresult rv = ReauthenticateUserMacOS(NS_ConvertUTF8toUTF16(*aReason),
                                        verified, blankPassword);
  return NS_SUCCEEDED(rv) && verified;
}

// Background thread. Encrypts aPlain with the keychain-held key, creating that
// key on first use, and writes base64 ciphertext into aOut.
nsresult zen_passkeys_encrypt(const nsACString* aPlain, nsACString* aOut) {
  if (!sKeyStore || !aPlain || !aOut) {
    return NS_ERROR_NOT_INITIALIZED;
  }
  bool available = false;
  nsresult rv = sKeyStore->SecretAvailable(kKeyLabel, &available);
  NS_ENSURE_SUCCESS(rv, rv);
  if (!available) {
    nsAutoCString unusedRecoveryPhrase;
    rv = sKeyStore->GenerateSecret(kKeyLabel, unusedRecoveryPhrase);
    NS_ENSURE_SUCCESS(rv, rv);
  }
  const uint8_t* bytes =
      reinterpret_cast<const uint8_t*>(aPlain->BeginReading());
  std::vector<uint8_t> plain(bytes, bytes + aPlain->Length());
  return sKeyStore->EncryptBytes(kKeyLabel, plain, *aOut);
}

// Background thread. Decrypts base64 ciphertext from zen_passkeys_encrypt.
nsresult zen_passkeys_decrypt(const nsACString* aCipher, nsACString* aOut) {
  if (!sKeyStore || !aCipher || !aOut) {
    return NS_ERROR_NOT_INITIALIZED;
  }
  uint32_t length = 0;
  uint8_t* bytes = nullptr;
  nsresult rv = sKeyStore->DecryptBytes(kKeyLabel, *aCipher, &length, &bytes);
  NS_ENSURE_SUCCESS(rv, rv);
  aOut->Assign(reinterpret_cast<const char*>(bytes), length);
  free(bytes);
  return NS_OK;
}

}  // extern "C"
