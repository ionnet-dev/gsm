import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  TemplateDefinitionInput,
  TemplateDetailDto,
  TemplateDto,
  VersionOption,
} from "@gsm/shared";
import { api, del, get, post } from "./client";

export const templateKeys = {
  all: ["templates"] as const,
  list: ["templates", "list"] as const,
  detail: (id: number) => ["templates", "detail", id] as const,
  versions: (source: string, parent: string | null) =>
    ["templates", "versions", source, parent ?? ""] as const,
};

export const useTemplates = () =>
  useQuery({
    queryKey: templateKeys.list,
    queryFn: () => get<{ items: TemplateDto[] }>("/templates"),
    select: (d) => d.items,
  });

export const useTemplate = (id: number | null) =>
  useQuery({
    queryKey: templateKeys.detail(id ?? 0),
    queryFn: () => get<{ template: TemplateDetailDto }>(`/templates/${id}`),
    select: (d) => d.template,
    enabled: id !== null,
  });

/** Versions from a version source (cached by the server). `parent` for loader versions. */
export const useVersions = (source: string | null, parent: string | null, enabled = true) =>
  useQuery({
    queryKey: templateKeys.versions(source ?? "", parent),
    queryFn: () =>
      get<{ versions: VersionOption[] }>("/templates/versions", {
        source,
        parent: parent ?? undefined,
      }),
    select: (d) => d.versions,
    enabled: enabled && !!source,
    staleTime: 10 * 60_000,
  });

export function useTemplateMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: templateKeys.all });
  return {
    create: useMutation({
      mutationFn: (definition: TemplateDefinitionInput) =>
        post<{ template: TemplateDetailDto }>("/templates", { definition }),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, definition }: { id: number; definition: TemplateDefinitionInput }) =>
        api<{ template: TemplateDetailDto }>(`/templates/${id}`, {
          method: "PUT",
          json: { definition },
        }),
      onSuccess: invalidate,
    }),
    copy: useMutation({
      mutationFn: ({ id, slug, name }: { id: number; slug: string; name: string }) =>
        post<{ template: TemplateDetailDto }>(`/templates/${id}/copy`, { slug, name }),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number) => del<{ ok: true }>(`/templates/${id}`),
      onSuccess: invalidate,
    }),
    import: useMutation({
      mutationFn: (definition: unknown) =>
        post<{ template: TemplateDetailDto }>("/templates/import", { definition }),
      onSuccess: invalidate,
    }),
  };
}
