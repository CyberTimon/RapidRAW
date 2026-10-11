pub fn available_and_total() -> (u64, u64) {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    available_and_total_from(&mut sys)
}

pub fn process_resident_bytes() -> u64 {

    let Ok(pid) = sysinfo::get_current_pid() else {
        return 0;
    };
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map_or(0, |p| p.memory())
}

pub struct ResidentMeter {
    system: std::sync::Mutex<sysinfo::System>,
    pid: sysinfo::Pid,
    peak: std::sync::atomic::AtomicU64,
}

impl ResidentMeter {
    pub fn new() -> Self {
        Self {
            system: std::sync::Mutex::new(sysinfo::System::new()),
            pid: sysinfo::get_current_pid().unwrap_or(sysinfo::Pid::from_u32(0)),
            peak: std::sync::atomic::AtomicU64::new(0),
        }
    }
    pub fn resident(&self) -> u64 {
        let Ok(mut sys) = self.system.lock() else {
            return 0;
        };
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[self.pid]), true);
        let value = sys.process(self.pid).map_or(0, |p| p.memory());
        self.peak
            .fetch_max(value, std::sync::atomic::Ordering::Relaxed);
        value
    }
    pub fn peak(&self) -> u64 {
        self.peak.load(std::sync::atomic::Ordering::Relaxed)
    }

}

impl Default for ResidentMeter {
    fn default() -> Self {
        Self::new()
    }
}

pub struct SystemMeter {
    system: std::sync::Mutex<sysinfo::System>,
}

impl SystemMeter {
    pub fn new() -> Self {
        Self {
            system: std::sync::Mutex::new(sysinfo::System::new()),
        }
    }
    pub fn used_and_total(&self) -> (u64, u64) {
        let Ok(mut sys) = self.system.lock() else {
            return (0, 0);
        };
        sys.refresh_memory();
        let (available, total) = available_and_total_from(&mut sys);
        (total.saturating_sub(available), total)
    }
    pub fn used(&self) -> u64 {
        self.used_and_total().0
    }
    pub fn total(&self) -> u64 {
        self.used_and_total().1
    }
}

impl Default for SystemMeter {
    fn default() -> Self {
        Self::new()
    }
}

fn available_and_total_from(sys: &mut sysinfo::System) -> (u64, u64) {
    let mut available = sys.available_memory();
    let mut total = sys.total_memory();
    if let Some(limits) = sys.cgroup_limits()
        && limits.total_memory > 0
    {
        total = total.min(limits.total_memory);
        if limits.free_memory > 0 {
            available = available.min(limits.free_memory);
        }
    }
    (available, total)
}

pub fn used_and_total_system() -> (u64, u64) {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let (available, total) = available_and_total_from(&mut sys);
    (total.saturating_sub(available), total)
}
