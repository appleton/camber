//! Derives a UTF-8 locale for Camber-spawned terminals.
//!
//! launchd gives GUI apps no locale variables, and shell profiles rarely
//! export one because a terminal emulator normally provides it. A
//! Finder-launched app therefore spawns PTYs in the POSIX C locale, where
//! locale-aware programs treat multibyte UTF-8 as binary — `less` (the pager
//! behind `git log`, `gt ls`, `man`, ...) renders box-drawing characters as
//! reverse-video `<E2><94><82>` byte escapes. Terminal emulators solve this
//! themselves: Terminal.app, iTerm2 and Ghostty all synthesize LANG from the
//! user's macOS locale preferences before spawning the shell. Do the same.

use std::{env, ffi::CString, ptr};

/// The `LANG` entry to add to a spawned terminal's environment, or `None`
/// when the inherited environment already pins a usable locale.
pub fn utf8_locale_env() -> Option<(&'static str, String)> {
    // LC_ALL overrides LANG in every locale-aware program; whoever set it
    // (user profile via shell_env, dev launch from a terminal) wins.
    if env::var("LC_ALL").is_ok_and(|value| !value.is_empty()) {
        return None;
    }
    // Keep an inherited LANG only if the C library actually accepts it; a
    // value like "en_150.UTF-8" would leave programs in the C locale anyway.
    if env::var("LANG").is_ok_and(|value| !value.is_empty() && is_valid_locale(&value)) {
        return None;
    }
    Some(("LANG", derived_utf8_locale()?))
}

/// First locale the C library accepts, preferring the user's system region.
fn derived_utf8_locale() -> Option<String> {
    system_locale_identifier()
        .as_deref()
        .and_then(candidate_from_identifier)
        .into_iter()
        // en_US.UTF-8 always exists on macOS; C.UTF-8 covers minimal Linux
        // images where no regional locale is generated.
        .chain(["en_US.UTF-8".to_string(), "C.UTF-8".to_string()])
        .find(|candidate| is_valid_locale(candidate))
}

/// Maps an NSLocale identifier to a POSIX locale name candidate:
/// "en_GB@rg=uszzzz" → "en_GB.UTF-8". Candidates the C library does not
/// recognize (e.g. script-tagged "zh-Hans_HK") are rejected by validation.
fn candidate_from_identifier(identifier: &str) -> Option<String> {
    let base = identifier.split('@').next().unwrap_or_default().trim();
    if base.is_empty() {
        return None;
    }
    Some(format!("{base}.UTF-8"))
}

fn is_valid_locale(name: &str) -> bool {
    let Ok(name) = CString::new(name) else {
        return false;
    };
    let locale = unsafe { libc::newlocale(libc::LC_ALL_MASK, name.as_ptr(), ptr::null_mut()) };
    if locale.is_null() {
        return false;
    }
    unsafe { libc::freelocale(locale) };
    true
}

#[cfg(target_os = "macos")]
fn system_locale_identifier() -> Option<String> {
    Some(
        objc2_foundation::NSLocale::currentLocale()
            .localeIdentifier()
            .to_string(),
    )
}

#[cfg(not(target_os = "macos"))]
fn system_locale_identifier() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_modifiers_from_locale_identifiers() {
        assert_eq!(
            candidate_from_identifier("en_GB@rg=uszzzz").as_deref(),
            Some("en_GB.UTF-8")
        );
        assert_eq!(
            candidate_from_identifier("de_DE").as_deref(),
            Some("de_DE.UTF-8")
        );
        assert_eq!(candidate_from_identifier(""), None);
        assert_eq!(candidate_from_identifier("@rg=uszzzz"), None);
    }

    #[test]
    fn validates_locales_against_the_c_library() {
        assert!(is_valid_locale("en_US.UTF-8"));
        assert!(!is_valid_locale("xx_XX.UTF-8"));
        assert!(!is_valid_locale("bad\0name"));
    }

    #[test]
    fn derived_locale_is_utf8() {
        let locale = derived_utf8_locale().expect("some UTF-8 locale must validate");
        assert!(locale.ends_with(".UTF-8"), "got {locale}");
        assert!(is_valid_locale(&locale));
    }
}
