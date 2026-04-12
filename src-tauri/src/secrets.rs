use anyhow::Result;
use keyring::Entry;

const SERVICE: &str = "dev.loach.app";
const OPENAI_ACCOUNT: &str = "openai_api_key";

fn entry() -> Result<Entry> {
    Ok(Entry::new(SERVICE, OPENAI_ACCOUNT)?)
}

pub fn set_openai_key(key: &str) -> Result<()> {
    entry()?.set_password(key)?;
    Ok(())
}

pub fn get_openai_key() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn has_openai_key() -> bool {
    matches!(get_openai_key(), Ok(Some(_)))
}

pub fn clear_openai_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
