use std::sync::atomic::{AtomicU8, Ordering};

const RUNNING: u8 = 0;
const STOPPING: u8 = 1;
const READY: u8 = 2;

#[derive(Default)]
pub(crate) struct Lifecycle(AtomicU8);

#[derive(Debug, PartialEq)]
pub(crate) enum ExitDecision {
    BeginShutdown,
    Wait,
    Exit,
}

impl Lifecycle {
    pub(crate) fn request_exit(&self) -> ExitDecision {
        match self
            .0
            .compare_exchange(RUNNING, STOPPING, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => ExitDecision::BeginShutdown,
            Err(READY) => ExitDecision::Exit,
            Err(_) => ExitDecision::Wait,
        }
    }

    pub(crate) fn running(&self) -> bool {
        self.0.load(Ordering::Acquire) == RUNNING
    }

    pub(crate) fn complete(&self) {
        self.0.store(READY, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    #[test]
    fn repeated_quit_waits_until_shutdown_finishes() {
        let lifecycle = Lifecycle::default();
        assert!(lifecycle.running());
        assert_eq!(lifecycle.request_exit(), ExitDecision::BeginShutdown);
        assert!(!lifecycle.running());
        for _ in 0..10 {
            assert_eq!(lifecycle.request_exit(), ExitDecision::Wait);
        }
        lifecycle.complete();
        assert_eq!(lifecycle.request_exit(), ExitDecision::Exit);
    }

    #[test]
    fn concurrent_exit_requests_begin_shutdown_once() {
        let lifecycle = Arc::new(Lifecycle::default());
        let barrier = Arc::new(Barrier::new(16));
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let lifecycle = lifecycle.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    lifecycle.request_exit()
                })
            })
            .collect();
        let decisions: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(
            decisions
                .iter()
                .filter(|d| **d == ExitDecision::BeginShutdown)
                .count(),
            1
        );
        assert_eq!(
            decisions
                .iter()
                .filter(|d| **d == ExitDecision::Wait)
                .count(),
            15
        );
    }
}
