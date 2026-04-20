//! Backend "tools" that augment a chat with out-of-band capabilities.
//!
//! The current lone tool is [`fetch_url`] — a simple URL prefetcher used when
//! the user includes links in their prompt. There is no search provider (yet);
//! the model doesn't get to *decide* to fetch. The frontend scans the user
//! message, calls `fetch_url` for each link, and inlines the returned text
//! into the outgoing prompt before streaming starts.

pub mod fetch_url;
