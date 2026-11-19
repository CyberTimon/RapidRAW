use std::collections::VecDeque;

const NO_PARENT: u32 = u32::MAX;
const TERMINAL: u32 = u32::MAX - 1;
const ORPHAN: u32 = u32::MAX - 2;
const NO_ARC: u32 = u32::MAX;

#[derive(Clone)]
struct Node {
    first: u32,
    parent: u32,
    timestamp: u32,
    distance: u32,
    is_sink: bool,
    active: bool,
    terminal_capacity: f64,
}

#[derive(Clone)]
struct Arc {
    head: u32,
    next: u32,
    residual: f64,
}

pub struct MaxFlow {
    nodes: Vec<Node>,
    arcs: Vec<Arc>,
    active: VecDeque<u32>,
    orphans: VecDeque<u32>,
    time: u32,
    flow: f64,
}

#[inline]
fn sister(arc: u32) -> u32 {
    arc ^ 1
}

impl MaxFlow {
    pub fn new(node_count: usize, arc_hint: usize) -> Self {
        MaxFlow {
            nodes: vec![
                Node {
                    first: NO_ARC,
                    parent: NO_PARENT,
                    timestamp: 0,
                    distance: 0,
                    is_sink: false,
                    active: false,
                    terminal_capacity: 0.0,
                };
                node_count
            ],
            arcs: Vec::with_capacity(arc_hint * 2),
            active: VecDeque::new(),
            orphans: VecDeque::new(),
            time: 0,
            flow: 0.0,
        }
    }

    pub fn add_edge(&mut self, i: usize, j: usize, capacity: f64, reverse_capacity: f64) {
        let forward = self.arcs.len() as u32;
        self.arcs.push(Arc {
            head: j as u32,
            next: self.nodes[i].first,
            residual: capacity,
        });
        self.nodes[i].first = forward;
        self.arcs.push(Arc {
            head: i as u32,
            next: self.nodes[j].first,
            residual: reverse_capacity,
        });
        self.nodes[j].first = forward + 1;
    }

    pub fn add_terminal_weights(&mut self, i: usize, source: f64, sink: f64) {
        let delta = self.nodes[i].terminal_capacity;
        let (source, sink) = if delta > 0.0 {
            (source + delta, sink)
        } else {
            (source, sink - delta)
        };
        self.flow += source.min(sink);
        self.nodes[i].terminal_capacity = source - sink;
    }

    pub fn is_source_side(&self, i: usize) -> Option<bool> {
        let node = &self.nodes[i];
        if node.parent == NO_PARENT {
            None
        } else {
            Some(!node.is_sink)
        }
    }

    fn set_active(&mut self, i: u32) {
        let node = &mut self.nodes[i as usize];
        if !node.active {
            node.active = true;
            self.active.push_back(i);
        }
    }

    fn next_active(&mut self) -> Option<u32> {
        while let Some(i) = self.active.pop_front() {
            self.nodes[i as usize].active = false;
            if self.nodes[i as usize].parent != NO_PARENT {
                return Some(i);
            }
        }
        None
    }

    pub fn solve(&mut self) -> f64 {
        for i in 0..self.nodes.len() {
            let node = &mut self.nodes[i];
            node.timestamp = 0;
            if node.terminal_capacity > 0.0 {
                node.is_sink = false;
                node.parent = TERMINAL;
                node.distance = 1;
            } else if node.terminal_capacity < 0.0 {
                node.is_sink = true;
                node.parent = TERMINAL;
                node.distance = 1;
            } else {
                node.parent = NO_PARENT;
                continue;
            }
            self.set_active(i as u32);
        }

        let mut current: Option<u32> = None;
        loop {
            let i = match current.take() {
                Some(i) if self.nodes[i as usize].parent != NO_PARENT => i,
                _ => match self.next_active() {
                    Some(i) => i,
                    None => break,
                },
            };

            let middle = self.grow(i);
            self.time += 1;

            if let Some(arc) = middle {
                current = Some(i);
                self.augment(arc);
                while let Some(orphan) = self.orphans.pop_front() {
                    if self.nodes[orphan as usize].is_sink {
                        self.process_orphan(orphan, true);
                    } else {
                        self.process_orphan(orphan, false);
                    }
                }
            }
        }
        self.flow
    }

    fn grow(&mut self, i: u32) -> Option<u32> {
        let i_sink = self.nodes[i as usize].is_sink;
        let mut a = self.nodes[i as usize].first;
        while a != NO_ARC {
            let capacity = if i_sink {
                self.arcs[sister(a) as usize].residual
            } else {
                self.arcs[a as usize].residual
            };
            if capacity > 0.0 {
                let j = self.arcs[a as usize].head;
                let (i_ts, i_dist) = {
                    let n = &self.nodes[i as usize];
                    (n.timestamp, n.distance)
                };
                let node_j = &mut self.nodes[j as usize];
                if node_j.parent == NO_PARENT {
                    node_j.is_sink = i_sink;
                    node_j.parent = sister(a);
                    node_j.timestamp = i_ts;
                    node_j.distance = i_dist + 1;
                    self.set_active(j);
                } else if node_j.is_sink != i_sink {
                    return Some(if i_sink { sister(a) } else { a });
                } else if node_j.timestamp <= i_ts && node_j.distance > i_dist {
                    node_j.parent = sister(a);
                    node_j.timestamp = i_ts;
                    node_j.distance = i_dist + 1;
                }
            }
            a = self.arcs[a as usize].next;
        }
        None
    }

    fn augment(&mut self, middle: u32) {
        let mut bottleneck = self.arcs[middle as usize].residual;

        let mut i = self.arcs[sister(middle) as usize].head;
        loop {
            let a = self.nodes[i as usize].parent;
            if a == TERMINAL {
                break;
            }
            bottleneck = bottleneck.min(self.arcs[sister(a) as usize].residual);
            i = self.arcs[a as usize].head;
        }
        bottleneck = bottleneck.min(self.nodes[i as usize].terminal_capacity);

        let mut i = self.arcs[middle as usize].head;
        loop {
            let a = self.nodes[i as usize].parent;
            if a == TERMINAL {
                break;
            }
            bottleneck = bottleneck.min(self.arcs[a as usize].residual);
            i = self.arcs[a as usize].head;
        }
        bottleneck = bottleneck.min(-self.nodes[i as usize].terminal_capacity);

        self.arcs[sister(middle) as usize].residual += bottleneck;
        self.arcs[middle as usize].residual -= bottleneck;

        let mut i = self.arcs[sister(middle) as usize].head;
        loop {
            let a = self.nodes[i as usize].parent;
            if a == TERMINAL {
                break;
            }
            self.arcs[a as usize].residual += bottleneck;
            self.arcs[sister(a) as usize].residual -= bottleneck;
            if self.arcs[sister(a) as usize].residual <= 0.0 {
                self.make_orphan(i, true);
            }
            i = self.arcs[a as usize].head;
        }
        self.nodes[i as usize].terminal_capacity -= bottleneck;
        if self.nodes[i as usize].terminal_capacity <= 0.0 {
            self.make_orphan(i, true);
        }

        let mut i = self.arcs[middle as usize].head;
        loop {
            let a = self.nodes[i as usize].parent;
            if a == TERMINAL {
                break;
            }
            self.arcs[sister(a) as usize].residual += bottleneck;
            self.arcs[a as usize].residual -= bottleneck;
            if self.arcs[a as usize].residual <= 0.0 {
                self.make_orphan(i, true);
            }
            i = self.arcs[a as usize].head;
        }
        self.nodes[i as usize].terminal_capacity += bottleneck;
        if self.nodes[i as usize].terminal_capacity >= 0.0 {
            self.make_orphan(i, true);
        }

        self.flow += bottleneck;
    }

    fn make_orphan(&mut self, i: u32, front: bool) {
        self.nodes[i as usize].parent = ORPHAN;
        if front {
            self.orphans.push_front(i);
        } else {
            self.orphans.push_back(i);
        }
    }

    fn origin_distance(&mut self, start: u32) -> Option<u32> {
        let mut j = start;
        let mut d = 0u32;
        loop {
            let node = &self.nodes[j as usize];
            if node.timestamp == self.time {
                d += node.distance;
                break;
            }
            let a = node.parent;
            d += 1;
            if a == TERMINAL {
                let node = &mut self.nodes[j as usize];
                node.timestamp = self.time;
                node.distance = 1;
                break;
            }
            if a == ORPHAN || a == NO_PARENT {
                return None;
            }
            j = self.arcs[a as usize].head;
        }
        Some(d)
    }

    fn mark_path(&mut self, start: u32, mut d: u32) {
        let mut j = start;
        while self.nodes[j as usize].timestamp != self.time {
            let node = &mut self.nodes[j as usize];
            node.timestamp = self.time;
            node.distance = d;
            d = d.saturating_sub(1);
            let a = node.parent;
            j = self.arcs[a as usize].head;
        }
    }

    fn process_orphan(&mut self, i: u32, sink_tree: bool) {
        let mut best_arc = NO_ARC;
        let mut best_distance = u32::MAX;

        let mut a0 = self.nodes[i as usize].first;
        while a0 != NO_ARC {
            let capacity = if sink_tree {
                self.arcs[a0 as usize].residual
            } else {
                self.arcs[sister(a0) as usize].residual
            };
            if capacity > 0.0 {
                let j = self.arcs[a0 as usize].head;
                let node_j = &self.nodes[j as usize];
                if node_j.is_sink == sink_tree
                    && node_j.parent != NO_PARENT
                    && let Some(d) = self.origin_distance(j)
                {
                    if d < best_distance {
                        best_arc = a0;
                        best_distance = d;
                    }
                    self.mark_path(j, d);
                }
            }
            a0 = self.arcs[a0 as usize].next;
        }

        if best_arc != NO_ARC {
            let node = &mut self.nodes[i as usize];
            node.parent = best_arc;
            node.timestamp = self.time;
            node.distance = best_distance + 1;
            return;
        }

        self.nodes[i as usize].parent = NO_PARENT;
        let mut a0 = self.nodes[i as usize].first;
        while a0 != NO_ARC {
            let j = self.arcs[a0 as usize].head;
            let (j_sink, j_parent) = {
                let n = &self.nodes[j as usize];
                (n.is_sink, n.parent)
            };
            if j_sink == sink_tree && j_parent != NO_PARENT {
                let capacity = if sink_tree {
                    self.arcs[a0 as usize].residual
                } else {
                    self.arcs[sister(a0) as usize].residual
                };
                if capacity > 0.0 {
                    self.set_active(j);
                }
                if j_parent != TERMINAL
                    && j_parent != ORPHAN
                    && self.arcs[j_parent as usize].head == i
                {
                    self.make_orphan(j, false);
                }
            }
            a0 = self.arcs[a0 as usize].next;
        }
    }
}
