import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type {
  FileListResult,
  FileReadResult,
  FilesSettings,
  FileTransferResult,
  FileWriteResult,
} from "@gsm/shared";
import { joinPath } from "@gsm/shared";
import { api, ApiError, get, post } from "./client";

export const fileKeys = {
  all: (id: number) => ["files", id] as const,
  dir: (id: number, path: string) => ["files", id, "dir", path] as const,
  content: (id: number, path: string) => ["files", id, "content", path] as const,
  limits: ["files", "limits"] as const,
};

const retry = (count: number, e: Error) => !(e instanceof ApiError && e.status < 500) && count < 2;

export const useDirectory = (instanceId: number, path: string, enabled = true) =>
  useQuery({
    queryKey: fileKeys.dir(instanceId, path),
    queryFn: () => get<FileListResult>(`/instances/${instanceId}/files`, { path }),
    enabled,
    staleTime: 5_000,
    retry,
    placeholderData: (prev) => prev,
  });

export const useFileLimits = () =>
  useQuery({
    queryKey: fileKeys.limits,
    queryFn: () => get<FilesSettings>("/files/limits"),
    staleTime: 60_000,
  });

/**
 * A file's content. Every read is audited, and an open editor must not be replaced under the
 * operator, so it is read once per opening and never refetched on its own.
 */
export const useFileContent = (instanceId: number, path: string | null) =>
  useQuery({
    queryKey: fileKeys.content(instanceId, path ?? ""),
    queryFn: () =>
      get<FileReadResult & { limit: number }>(`/instances/${instanceId}/files/content`, { path }),
    enabled: path !== null,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

export function useFileActions(instanceId: number) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: [...fileKeys.all(instanceId), "dir"] });
  const base = `/instances/${instanceId}/files`;
  return {
    write: useMutation({
      mutationFn: (b: {
        path: string;
        content: string;
        expectSha256: string | null;
        create?: boolean;
      }) => api<FileWriteResult>(`${base}/content`, { method: "PUT", json: b }),
      onSuccess: refresh,
    }),
    mkdir: useMutation({
      mutationFn: (b: { path: string }) => post<{ path: string }>(`${base}/mkdir`, b),
      onSuccess: refresh,
    }),
    rename: useMutation({
      mutationFn: (b: { from: string; to: string }) => post<{ path: string }>(`${base}/rename`, b),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (b: { paths: string[] }) => post<{ deleted: number }>(`${base}/delete`, b),
      onSuccess: refresh,
      onError: refresh, // a partial delete still changed the listing
    }),
    chmod: useMutation({
      mutationFn: (b: { paths: string[]; mode: number; recursive: boolean }) =>
        post<{ changed: number }>(`${base}/chmod`, b),
      onSuccess: refresh,
    }),
    extract: useMutation({
      mutationFn: (b: { path: string; dest: string }) =>
        post<{ files: number }>(`${base}/extract`, b),
      onSuccess: refresh,
    }),
    compress: useMutation({
      mutationFn: (b: { paths: string[]; dest: string }) =>
        post<FileTransferResult>(`${base}/compress`, b),
      onSuccess: refresh,
    }),
    /** Reserve a download and hand it to the browser's own download manager. */
    download: useMutation({
      mutationFn: async (b: { paths: string[] }) => {
        const r = await post<{ url: string; filename: string; archive: boolean }>(
          `${base}/download`,
          b,
        );
        const a = document.createElement("a");
        a.href = r.url;
        a.download = r.filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        return r;
      },
    }),
  };
}

// ---- uploads ----

export interface UploadItem {
  id: string;
  instanceId: number;
  name: string;
  path: string;
  size: number;
  loaded: number;
  state: "uploading" | "done" | "failed" | "cancelled";
  error: string | null;
  /** After the bytes reached the server it waits for the node to verify and place the file. */
  placing: boolean;
  xhr: XMLHttpRequest | null;
}

/** Send a body with upload progress (fetch has none). Resolves with the parsed JSON response. */
function xhrSend<T>(
  method: "PUT" | "POST",
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  onSent: () => void,
  bind: (xhr: XMLHttpRequest) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    bind(xhr);
    xhr.open(method, url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-gsm-client", "web");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.upload.onload = onSent;
    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(parsed as T);
      const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
      reject(
        new ApiError(
          xhr.status,
          err?.code ?? "http_error",
          err?.message ?? `Upload failed (${xhr.status})`,
        ),
      );
    };
    xhr.onerror = () => reject(new ApiError(0, "network", "The connection was lost"));
    xhr.onabort = () => reject(new ApiError(0, "cancelled", "Cancelled"));
    xhr.send(body);
  });
}

class Uploads {
  private items: UploadItem[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;
  /** Called when an upload into a directory finished, to refresh its listing. */
  onFinished: ((instanceId: number) => void) | null = null;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = () => this.items;

  private set(id: string, patch: Partial<UploadItem>) {
    this.items = this.items.map((u) => (u.id === id ? { ...u, ...patch } : u));
    for (const l of this.listeners) l();
  }

  start(instanceId: number, dir: string, file: File, opts: { overwrite?: boolean; name?: string }) {
    const id = `u${++this.seq}`;
    const name = opts.name ?? file.name;
    const path = joinPath(dir, name);
    this.items = [...this.items, {
      id,
      instanceId,
      name,
      path,
      size: file.size,
      loaded: 0,
      state: "uploading",
      error: null,
      placing: false,
      xhr: null,
    }];
    for (const l of this.listeners) l();
    const qs = new URLSearchParams({ path });
    if (opts.overwrite) qs.set("overwrite", "1");
    xhrSend<FileTransferResult>(
      "PUT",
      `/api/v1/instances/${instanceId}/files/upload?${qs}`,
      file,
      (loaded) => this.set(id, { loaded }),
      () => this.set(id, { loaded: file.size, placing: true }),
      (xhr) => this.set(id, { xhr }),
    )
      .then(() => this.set(id, { state: "done", placing: false, xhr: null }))
      .catch((e: ApiError) =>
        this.set(id, {
          state: e.code === "cancelled" ? "cancelled" : "failed",
          error: e.code === "cancelled" ? null : e.message,
          placing: false,
          xhr: null,
        })
      )
      .finally(() => this.onFinished?.(instanceId));
    return id;
  }

  cancel(id: string) {
    this.items.find((u) => u.id === id)?.xhr?.abort();
  }

  dismiss(id: string) {
    this.items = this.items.filter((u) => u.id !== id);
    for (const l of this.listeners) l();
  }

  clearFinished() {
    this.items = this.items.filter((u) => u.state === "uploading");
    for (const l of this.listeners) l();
  }
}

export const uploads = new Uploads();

export function useUploads(): UploadItem[] {
  return useSyncExternalStore(uploads.subscribe, uploads.snapshot);
}
