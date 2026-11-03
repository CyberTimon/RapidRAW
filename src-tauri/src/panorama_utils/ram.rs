pub fn process_resident_bytes() -> u64 {
    let Ok(pid) = sysinfo::get_current_pid() else {
        return 0;
    };
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map_or(0, |p| p.memory())
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
