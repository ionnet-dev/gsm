import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AddSshKeyBody, InstanceSftpDto, SshKeyDto } from "@gsm/shared";
import { del, get, post } from "./client";

export const sftpKeys = {
  /** Under "instances" so instance updates refresh it. */
  instance: (id: number) => ["instances", "sftp", id] as const,
  sshKeys: ["ssh-keys"] as const,
};

export const useInstanceSftp = (id: number, enabled = true) =>
  useQuery({
    queryKey: sftpKeys.instance(id),
    queryFn: () => get<{ sftp: InstanceSftpDto }>(`/instances/${id}/sftp`),
    select: (d) => d.sftp,
    enabled,
  });

/** The requester's SFTP password on one instance; `reset` returns the new plaintext once. */
export function useSftpPassword(id: number) {
  const qc = useQueryClient();
  const store = (d: { sftp: InstanceSftpDto }) =>
    qc.setQueryData(sftpKeys.instance(id), { sftp: d.sftp });
  return {
    reset: useMutation({
      mutationFn: () =>
        post<{ password: string; sftp: InstanceSftpDto }>(`/instances/${id}/sftp/password`),
      onSuccess: store,
    }),
    remove: useMutation({
      mutationFn: () => del<{ sftp: InstanceSftpDto }>(`/instances/${id}/sftp/password`),
      onSuccess: store,
    }),
  };
}

export const useSshKeys = () =>
  useQuery({
    queryKey: sftpKeys.sshKeys,
    queryFn: () => get<{ items: SshKeyDto[] }>("/ssh-keys"),
    select: (d) => d.items,
  });

export function useSshKeyMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: sftpKeys.sshKeys });
    qc.invalidateQueries({ queryKey: ["instances", "sftp"] });
  };
  return {
    add: useMutation({
      mutationFn: (body: AddSshKeyBody) => post<{ key: SshKeyDto }>("/ssh-keys", body),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number) => del<{ ok: true }>(`/ssh-keys/${id}`),
      onSuccess: invalidate,
    }),
  };
}
