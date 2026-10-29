use anyhow::{ensure, Result};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct State {
    closed: bool,
    active: BTreeMap<String, CancellationToken>,
}

#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    changed: Notify,
}

/// Admit work atomically, cancel it cooperatively, and await its actual cleanup.
#[derive(Default)]
pub struct Operations(Arc<Inner>);

pub struct Operation {
    inner: Arc<Inner>,
    id: String,
    token: CancellationToken,
}

impl Operations {
    pub fn begin(&self, id: &str) -> Result<Operation> {
        self.admit(id, CancellationToken::new())
    }

    pub(crate) fn begin_child(&self, id: &str, parent: &CancellationToken) -> Result<Operation> {
        self.admit(id, parent.child_token())
    }

    fn admit(&self, id: &str, token: CancellationToken) -> Result<Operation> {
        let mut state = self.0.state.lock().unwrap();
        ensure!(!state.closed, "StackCabin is shutting down");
        ensure!(
            !state.active.contains_key(id),
            "Operation ID is already active: {id}"
        );
        state.active.insert(id.into(), token.clone());
        Ok(Operation {
            inner: self.0.clone(),
            id: id.into(),
            token,
        })
    }

    pub fn enter(&self) -> Result<Operation> {
        self.begin(&uuid::Uuid::new_v4().to_string())
    }

    pub fn cancel(&self, id: &str) {
        let token = self.0.state.lock().unwrap().active.get(id).cloned();
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub fn close(&self) {
        let tokens: Vec<_> = {
            let mut state = self.0.state.lock().unwrap();
            state.closed = true;
            state.active.values().cloned().collect()
        };
        for token in tokens {
            token.cancel();
        }
    }

    pub fn closed(&self) -> bool {
        self.0.state.lock().unwrap().closed
    }

    pub async fn wait_idle(&self) {
        loop {
            let changed = self.0.changed.notified();
            tokio::pin!(changed);
            // Subscribe before checking, including completion on another thread.
            changed.as_mut().enable();
            if self.0.state.lock().unwrap().active.is_empty() {
                return;
            }
            changed.await;
        }
    }
}

impl Operation {
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        self.inner.state.lock().unwrap().active.remove(&self.id);
        self.inner.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::poll;

    #[tokio::test]
    async fn shutdown_cancels_work_but_waits_for_every_owner_to_finish() {
        let operations = Operations::default();
        let first = operations.begin("first").unwrap();
        let second = operations.begin("second").unwrap();
        assert!(operations.begin("first").is_err());
        operations.close();
        assert!(first.token().is_cancelled() && second.token().is_cancelled());
        assert!(operations.enter().is_err());
        let idle = operations.wait_idle();
        tokio::pin!(idle);
        assert!(poll!(idle.as_mut()).is_pending());
        drop(first);
        assert!(poll!(idle.as_mut()).is_pending());
        drop(second);
        idle.await;
    }

    #[tokio::test]
    async fn cancellation_and_dropped_tasks_release_their_exact_operation() {
        let operations = Operations::default();
        let first = operations.begin("same").unwrap();
        let second = operations.begin("other").unwrap();
        operations.cancel("same");
        assert!(first.token().is_cancelled());
        assert!(!second.token().is_cancelled());
        drop(first);
        let replacement = operations.begin("same").unwrap();
        assert!(!replacement.token().is_cancelled());
        drop(replacement);
        drop(second);
        let parent = CancellationToken::new();
        parent.cancel();
        let late_child = operations.begin_child("next-stage", &parent).unwrap();
        assert!(late_child.token().is_cancelled());
        drop(late_child);
        operations.wait_idle().await;
    }
}
