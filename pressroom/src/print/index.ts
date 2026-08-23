import type { Config, Secrets } from "../config.js";
import type { Issue } from "../types.js";
import { newspaperClubHandoff } from "./newspaperclub.js";
import { placePeechoOrder } from "./peecho.js";

export interface PrintResult {
  vendor: string;
  /** True only when a printer has actually taken the job. */
  placed: boolean;
  /** True when the last step is a human uploading the file. */
  requiresManualUpload: boolean;
  reference?: string;
  instructions?: string;
  uploadUrl?: string;
}

export async function placeOrder(
  issue: Issue,
  config: Config,
  secrets: Secrets,
  printPath: string,
  options: { dryRun: boolean },
): Promise<PrintResult> {
  switch (config.print.vendor) {
    case "peecho":
      return placePeechoOrder(issue, config, secrets, printPath, options);
    case "newspaperclub":
      return newspaperClubHandoff(issue, config, printPath);
    case "none":
      return {
        vendor: "none",
        placed: false,
        requiresManualUpload: true,
        instructions: `The file is at ${printPath}. No print vendor is configured.`,
      };
  }
}
