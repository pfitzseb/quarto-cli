/*
 * devcontainer.ts
 *
 * Copyright (C) 2021-2022 Posit Software, PBC
 */

import { Command } from "cliffy/command/mod.ts";
import { initYamlIntelligenceResourcesFromFilesystem } from "../../../core/schema/utils.ts";
import { createTempContext } from "../../../core/temp.ts";
import { info } from "log/mod.ts";
import { InternalError } from "../../../core/lib/error.ts";

import { extname, join } from "path/mod.ts";
import { ensureDirSync, existsSync } from "fs/mod.ts";
import { dirname } from "path/mod.ts";
import { Table } from "cliffy/table/mod.ts";
import { Confirm, Input } from "cliffy/prompt/mod.ts";
import { projectContext } from "../../../project/project-context.ts";
import { projectType } from "../../../project/types/project-types.ts";
import {
  kManuscriptType,
  ResolvedManuscriptConfig,
} from "../../../project/types/manuscript/manuscript-types.ts";
import { isPdfOutput } from "../../../config/format.ts";
import { ProjectContext } from "../../../project/types.ts";
import { withSpinner } from "../../../core/console.ts";

// Discover environment
// Validate that lock file or requirements.txt is present
// Compute defaults
//   R => RStudio, renv.lock
//   Python w/ipynb => JupyterLab, requirements.txt
//   Python / non-R => Vscode, requirements.txt

// R devcontainer template
// https://github.com/rocker-org/devcontainer-templates/tree/main/src/r-ver
// Python 3
// https://github.com/devcontainers/templates/tree/main/src/python

/*
 "codespaces": {
            "openFiles": ["README.md"]
        }
        */

const kDefaultContainerTitle = "Default Container";

interface DevContainer {
  name: string;
  image: string;
  customizations?: {
    vscode?: {
      extensions?: string[];
    };
  };
  features?: Record<string, Record<string, unknown>>;
  postCreateCommand?: string;
  postAttachCommand?: string;
  postStartCommand?: string;
  forwardPorts?: number[];
  portsAttributes?: Record<string, PortAttribute>;
  codespaces?: Record<string, unknown>;
  containerEnv?: Record<string, string>;
}

interface PortAttribute {
  label: string;
  requireLocalPort: boolean;
  onAutoForward: string;
}

interface ContainerContext {
  title?: string;
  tools: Array<"tinytex" | "chromium">;
  codeEnvironment: "vscode" | "rstudio" | "jupyterlab";
  engines: string[];
  quarto: "release" | "prerelease";
  environments: string[];
  openFiles: string[];
  envVars: Record<string, string>;
}

// The devcontainer can be ina  file, directory, or a subdirectory (where multiple subdirectories
// could be used to provide the user with a choice of dev containers)
type pathType = "file" | "directory" | "subdirectory";

// The current global image that we use for the devcontainer
const kBaseContainerImage = "mcr.microsoft.com/devcontainers/base:ubuntu";
const kRstudioContainerImage = "ghcr.io/rocker-org/rstudio:4.3.1";

// Regex used to determine whether file contents will require the installation of Chromium
const kChromiumHint = /````*{mermaid}|{dot}/gm;

// Options
// name - the name of the devcontainer

// Scan inputs for languages
// if R / qmd
// if python / ipynb
// if other QMD

// if knitr, default to rstudio
// if jupyter, look for qmds vs ipynb
// for general projects, count:
// if qmd, then vscode
// if ipynb, then jupyterlab
// for manuscripts:
// if article is qmd, vscode
// if article is ipynb, jupyterlab

// only install tinytex if pdf is present

// dont' install chromium unless mermaid or graphviz is present

// use rocker images with features to customize

// knitr - rocker base images
// jupyter, use standard with python composed
//  ipynb vs qmd for tooling

export const useDevContainerCommand = new Command()
  .name("devcontainer")
  .description(
    "Use a Dev Container for this project.",
  )
  .option(
    "--no-prompt",
    "Do not prompt to confirm actions",
  )
  .example(
    "Use a Dev Container",
    "quarto use devcontainer",
  )
  .action(async (_options: { prompt?: boolean }) => {
    await initYamlIntelligenceResourcesFromFilesystem();
    const temp = createTempContext();
    try {
      // Note: this will throw if this isn't a project, which is expected
      // and desirable
      const context = await withSpinner<ProjectContext | undefined>({
        message: "Scanning project",
        doneMessage: false,
      }, () => {
        return projectContext(Deno.cwd());
      });

      if (context === undefined) {
        throw new InternalError(
          "The quarto use devcontainer command expects to be run in a Quarto project",
        );
      }
      const containerCtx = await resolveContainerContext(
        context,
        "prerelease",
      );

      // Confirm the container title
      const userTitle = await confirmTitle(
        containerCtx.title || kDefaultContainerTitle,
      );
      containerCtx.title = userTitle;

      // Confirm the container context
      const contextConfirmed = await confirmContext(containerCtx);
      if (!contextConfirmed) {
        return;
      }

      validateContext(containerCtx);

      // The devcontainer JSON that we are building
      const devcontainer: DevContainer = {
        name: userTitle,
        image: containerImage(containerCtx),
        features: resolveFeatures(containerCtx),
      };

      // Compute the depdendencies to restore
      const postCreateCommand = await postCreate(containerCtx);
      if (postCreateCommand) {
        devcontainer.postCreateCommand = postCreateCommand;
      }

      // Compute the post attach command (if any)
      const postAttachCommand = await postAttach(containerCtx);
      if (postAttachCommand) {
        devcontainer.postAttachCommand = postAttachCommand;
      }

      const postStartCommand = await postStart(containerCtx);
      if (postStartCommand) {
        devcontainer.postStartCommand = postStartCommand;
      }

      const portInfo = await portAttributes(containerCtx);
      if (portInfo) {
        // Forward ports
        devcontainer.forwardPorts = devcontainer.forwardPorts || [];
        const portNumbers = Object.keys(portInfo).map(parseInt);
        devcontainer.forwardPorts.push(...portNumbers);

        // Forward port attributes
        devcontainer.portsAttributes = devcontainer.portsAttributes || {};
        for (const port of Object.keys(portInfo)) {
          devcontainer.portsAttributes[port] = portInfo[port];
        }
      }

      if (containerCtx.openFiles.length > 0) {
        devcontainer.codespaces = {
          openFiles: containerCtx.openFiles,
        };
      }

      const envVars = Object.keys(containerCtx.envVars);
      if (envVars.length > 0) {
        devcontainer.containerEnv = devcontainer.containerEnv || {};
        for (const key of envVars) {
          devcontainer.containerEnv[key] = containerCtx.envVars[key];
        }
      }

      // Where to write the dev conatiner json
      const outputPath = devcontainerPath();

      // Print a summary of devconatiner
      const proceed = await confirmChanges(devcontainer);
      if (proceed) {
        // Validate that the path doesn't exist
        if (!existsSync(outputPath) || await confirmOverwrite(outputPath)) {
          ensureDirSync(dirname(outputPath));

          // Write the devcontainer JSON
          const devcontainerJson = JSON.stringify(devcontainer, undefined, 2);
          Deno.writeTextFileSync(outputPath, devcontainerJson);

          info("\nDevelopment container successfully created.");
        }
      }
    } finally {
      temp.cleanup();
    }
  });

const resolveContainerContext = async (
  context: ProjectContext,
  quarto: "release" | "prerelease",
) => {
  const containerCtx: ContainerContext = {
    engines: context.engines,
    tools: [],
    codeEnvironment: "vscode",
    quarto,
    environments: [],
    openFiles: [],
    envVars: {},
  };

  const qmdCodeTool = context.engines.includes("knitr") ? "rstudio" : "vscode";
  const ipynbCodeTool = "jupyterlab";

  // Determine the code environment
  // Special case manuscripts - the root article will drive the code environment
  if (projectType(context.config?.project.type).type === kManuscriptType) {
    // Choose the code environment based upon the engine and article file type
    const manuscriptConfig = context.config
      ?.[kManuscriptType] as ResolvedManuscriptConfig;
    if (extname(manuscriptConfig.article) === ".qmd") {
      containerCtx.codeEnvironment = qmdCodeTool;
    } else {
      containerCtx.codeEnvironment = ipynbCodeTool;
    }

    // Open the main article file
    containerCtx.openFiles.unshift(manuscriptConfig.article);
  } else {
    // Count the ipynb vs qmds and use that as guideline
    const exts: Record<string, number> = {};
    const inputs = context.files.input;
    for (const input of inputs) {
      const ext = extname(input);
      exts[ext] = (exts[ext] || 0) + 1;
    }

    const qmdCount = exts[".qmd"] || 0;
    const ipynbCount = exts[".ipynb"] || 0;
    if (qmdCount >= ipynbCount) {
      containerCtx.codeEnvironment = qmdCodeTool;
    } else {
      containerCtx.codeEnvironment = ipynbCodeTool;
    }
  }

  // Determine the title
  const title = context.config?.project.title;
  containerCtx.title = title;

  // Determine what tools (if any) we should also install
  let tinytex = false;
  let chromium = false;

  for (const input of context.files.input) {
    if (!tinytex) {
      // If we haven't yet found the need for tinytex,
      // go ahead and look for PDF format. Once a single
      // file needs, it we can stop looking
      const formats = await context.renderFormats(input, "all", context);

      const hasPdf = Object.values(formats).some((format) => {
        return isPdfOutput(format.pandoc);
      });
      tinytex = hasPdf;
    }

    // See if the file contains mermaid or graphviZ
    if (!chromium) {
      const contents = Deno.readTextFileSync(input);
      if (contents.match(kChromiumHint)) {
        chromium = true;
      }
    }

    if (tinytex && chromium) {
      break;
    }
  }

  if (tinytex) {
    containerCtx.tools.push("tinytex");
  }

  if (chromium) {
    containerCtx.tools.push("chromium");
  }

  // Determine environments
  const envFiles = Object.keys(environmentCommands);
  for (const envFile of envFiles) {
    if (existsSync(envFile)) {
      containerCtx.environments.push(envFile);
    }
  }

  return containerCtx;
};

const resolveFeatures = (ctx: ContainerContext) => {
  const features: Record<string, Record<string, unknown>> = {};
  if (ctx.engines.includes("knitr")) {
    features["ghcr.io/rocker-org/devcontainer-features/r-rig:1"] = {
      vscodeRSupport: ctx.codeEnvironment === "vscode",
      installJupyterlab: ctx.engines.includes("jupyter"),
      installREnv: true,
      installRMarkdown: true,
    };
  } else if (ctx.engines.includes("jupyter")) {
    features["ghcr.io/devcontainers/features/python:1"] = {
      installJupyterlab: ctx.codeEnvironment === "jupyterlab",
    };
  }

  // Add Quarto
  features["ghcr.io/rocker-org/devcontainer-features/quarto-cli:1"] = {
    version: ctx.quarto,
    installTinyTex: ctx.tools.includes("tinytex"),
    installChromium: ctx.tools.includes("chromium"),
  };

  // For environments, add features
  const commands = ctx.environments.map((env) => {
    return environmentCommands[env];
  });
  for (const env of commands) {
    if (env.features) {
      for (const key of Object.keys(env.features)) {
        features[key] = env.features[key];
      }
    }
  }

  return features;
};

const confirmContext = async (ctx: ContainerContext) => {
  const rows: string[][] = [];
  const indent = "  ";

  if (ctx.title) {
    rows.push([indent, "Name:", ctx.title]);
  }
  rows.push([indent, "Quarto:", ctx.quarto]);
  rows.push([indent, "Tools:", ctx.tools.join(",")]);
  rows.push([indent, "Engines:", ctx.engines.join(",")]);
  rows.push([indent, "IDE", ctx.codeEnvironment]);
  if (ctx.environments.length > 0) {
    rows.push([indent, "Environment", ctx.environments.join(",")]);
  }

  const table = new Table(...rows);

  info(
    `\nThe following options will be used for your project container:\n\n${table.toString()}\n`,
  );
  const question = "Would you like to continue";
  return await Confirm.prompt({ message: question, default: true });
};

const validateContext = (ctx: ContainerContext) => {
  if (ctx.environments.length === 0) {
    throw new Error(
      "Unable to determine depedencies for this projects. Please ensure that a depedencies file is present.",
    );
  }
};

const confirmChanges = async (_devContainer: DevContainer) => {
  return true;

  /*
  const rows: string[][] = [];
  const indent = "  ";
  rows.push([indent, "Name:", devContainer.name]);
  rows.push([indent, "Docker Image:", devContainer.image]);
  if (devContainer.postCreateCommand) {
    rows.push([indent, "Dependencies:", devContainer.postCreateCommand]);
  }

  const table = new Table(...rows);
  info(
    `\nA development container with the following options will be created:\n\n${table.toString()}\n`,
  );
  const question = "Would you like to continue";
  return await Confirm.prompt({ message: question, default: true });
  */
};

const confirmOverwrite = async (path: string) => {
  info(
    `\nA development container at ${path} already exists.`,
  );
  return await Confirm.prompt({
    message: "Do you want to overwrite it?",
    default: false,
  });
};

const confirmTitle = async (title: string) => {
  info("Container name:");
  return await Input.prompt({ message: "Container name:", default: title });
};

const devcontainerPath = (
  type: pathType = "directory",
  devcontainerName?: string,
) => {
  switch (type) {
    case "file":
      return ".devcontainer.json";

    case "subdirectory":
      if (!devcontainerName) {
        throw new InternalError(
          "In order to create a subdirectory devcontainer, you must provide a devcontainer name",
        );
      }
      return join(".devcontainer", devcontainerName, "devcontainer.json");

    case "directory":
    default:
      return join(".devcontainer", "devcontainer.json");
  }
};

const containerImage = (ctx: ContainerContext) => {
  if (ctx.codeEnvironment === "rstudio") {
    return kRstudioContainerImage;
  } else {
    // Always use our base image. If we get more sophisticated
    // about images, we can add sophistication here
    return kBaseContainerImage;
  }
};

const postCreate = async (ctx: ContainerContext) => {
  const command = ctx.environments.map((env) => {
    return environmentCommands[env].restore;
  }).filter((cmd) => cmd !== undefined);

  if (command.length > 0) {
    return command.join(" && ");
  }
};

const postAttach = async (ctx: ContainerContext) => {
  const postAttachCmd: string[] = [];
  if (ctx.codeEnvironment === "rstudio") {
    postAttachCmd.push("sudo rstudio-server start");
  } else if (ctx.codeEnvironment === "jupyterlab") {
    postAttachCmd.push("python3 -m pip install jupyterlab-quarto");
    postAttachCmd.push("python3 -m jupyterlab");
  }
  return postAttachCmd.join(" && ");
};

const postStart = async (_ctx: ContainerContext) => {
  return undefined;
};

const portAttributes = async (ctx: ContainerContext) => {
  return kPortAttr[ctx.codeEnvironment];
};

interface EnvironmentOptions {
  restore?: string;
  features?: Record<string, Record<string, unknown>>;
}

const environmentCommands: Record<string, EnvironmentOptions> = {
  // TODO: this needs to happen in correct directory post setup
  "renv.lock": { restore: `Rscript -e "renv::restore();"` },
  "requirements.txt": {
    restore: `python3 -m pip3 install -r requirements.txt`,
  },
  "environment.yml": {
    restore: "conda env create -f environment.yml",
    features: {
      "ghcr.io/devcontainers/features/conda:1": {
        addCondaForge: true,
      },
    },
  },
};

const kPortAttr: Record<string, Record<string, PortAttribute>> = {
  "rstudio": {
    "8787": {
      "label": "Rstudio",
      "requireLocalPort": true,
      "onAutoForward": "ignore",
    },
  },
  "jupyterlab": {
    "8888": {
      "label": "Jupyter",
      "requireLocalPort": true,
      "onAutoForward": "ignore",
    },
  },
};

// If no environment detected, use langugage to determine a URL to a page on our docs that describes what to do
// If no environment prsent, throw error
