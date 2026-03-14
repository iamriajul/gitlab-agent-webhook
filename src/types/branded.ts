declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ProjectPath = Brand<string, "ProjectPath">;
export type IssueIid = Brand<number, "IssueIid">;
export type MRIid = Brand<number, "MRIid">;
export type NoteId = Brand<number, "NoteId">;
export type JobId = Brand<string, "JobId">;
export type SessionId = Brand<string, "SessionId">;

export function projectPath(value: string): ProjectPath {
  return value as ProjectPath;
}

export function issueIid(value: number): IssueIid {
  return value as IssueIid;
}

export function mrIid(value: number): MRIid {
  return value as MRIid;
}

export function noteId(value: number): NoteId {
  return value as NoteId;
}

export function jobId(value: string): JobId {
  return value as JobId;
}

export function sessionId(value: string): SessionId {
  return value as SessionId;
}
