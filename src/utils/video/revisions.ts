import { invoke } from '@tauri-apps/api/core';
import { Invokes } from '../../types/invokes';
import { VideoProject } from '../../types/video';
import { Adjustments } from '../adjustments';
import { enterSequence } from './nesting';

const UNKNOWN_REVISION = 'Unknown project revision';

interface Sent {
  project: VideoProject;
  revision: number;
}

const revisions = new WeakMap<VideoProject, Promise<number>>();
const sequences = new WeakMap<VideoProject, Map<string, VideoProject>>();
let latest: Sent | null = null;

const isUnknown = (err: unknown) => String(err).includes(UNKNOWN_REVISION);

export const rawJson = (value: object) => new TextEncoder().encode(JSON.stringify(value));

const projectBody = (project: VideoProject, base: Sent | null) => {
  const keep: Array<string> = [];
  const looks: Record<string, Adjustments> = {};
  Object.entries(project.looks).forEach(([id, look]) => {
    if (base?.project.looks[id] === look) keep.push(id);
    else looks[id] = look;
  });
  const header = rawJson({ base: base?.revision ?? null, keep, looks });
  const rest = rawJson({ ...project, looks: undefined });
  const body = new Uint8Array(4 + header.length + rest.length);
  new DataView(body.buffer).setUint32(0, header.length, true);
  body.set(header, 4);
  body.set(rest, 4 + header.length);
  return body;
};

const setProject = (project: VideoProject, base: Sent | null) =>
  invoke<number>(Invokes.VideoSetProject, projectBody(project, base));

const sendProject = (project: VideoProject) => {
  const base = latest;
  const sent = setProject(project, base)
    .catch((err) => {
      if (!base || !isUnknown(err)) throw err;
      return setProject(project, null);
    })
    .then((revision) => {
      latest = { project, revision };
      return revision;
    });
  revisions.set(project, sent);
  sent.catch(() => {
    if (revisions.get(project) === sent) revisions.delete(project);
  });
  return sent;
};

export const projectRevision = (project: VideoProject) => revisions.get(project) ?? sendProject(project);

export const withRevision = async <T>(project: VideoProject, use: (revision: number) => Promise<T>): Promise<T> => {
  const sent = projectRevision(project);
  try {
    return await use(await sent);
  } catch (err) {
    if (!isUnknown(err)) throw err;
    if (revisions.get(project) === sent) revisions.delete(project);
    return use(await projectRevision(project));
  }
};

export const reuseLast = <A extends Array<unknown>, R>(build: (...args: A) => R) => {
  let last: { args: A; result: R } | null = null;
  return (...args: A): R => {
    const previous = last;
    if (previous && args.every((arg, index) => arg === previous.args[index])) return previous.result;
    const result = build(...args);
    last = { args, result };
    return result;
  };
};

export const sequenceProject = (project: VideoProject, id: string) => {
  const entered = sequences.get(project) ?? new Map<string, VideoProject>();
  sequences.set(project, entered);
  const known = entered.get(id);
  if (known) return known;
  const next = enterSequence(project, id);
  entered.set(id, next);
  return next;
};
