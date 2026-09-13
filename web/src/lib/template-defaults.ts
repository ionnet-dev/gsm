import type { TemplateDefinitionInput, TemplateVariable } from "@gsm/shared";

/** A minimal generic template new custom templates start from. */
export const GENERIC_TEMPLATE: TemplateDefinitionInput = {
  schemaVersion: 1,
  slug: "custom",
  name: "Custom server",
  game: "Custom",
  description: "A generic template: bring your own image, install script and startup command.",
  icon: "🎮",
  tags: [],
  image: "ghcr.io/ionnet-dev/gsm-base:latest",
  images: [],
  install: {
    image: null,
    script:
      '#!/bin/sh\nset -eu\ncd /data\necho "Nothing to install; put your server files in /data."\n',
    resolver: null,
    timeoutSeconds: 1800,
  },
  startup: "./start.sh",
  stop: { command: null, signal: "SIGTERM", timeoutSeconds: 30 },
  console: { readyPattern: null },
  variables: [],
  ports: [{ name: "game", label: "Game port", protocol: "tcp", default: 27015, primary: true }],
  files: [],
  resources: { memoryMb: 2048, cpuCores: 0, diskMb: 0 },
  restartOnCrash: true,
  backupIgnore: ["logs/**", "*.log"],
};

export const NEW_VARIABLE: TemplateVariable = {
  name: "NEW_VARIABLE",
  label: "New variable",
  description: "",
  type: "text",
  default: "",
  required: false,
  options: [],
  min: null,
  max: null,
  versionSource: null,
  dependsOn: null,
  editable: true,
  viewable: true,
  pattern: null,
};
