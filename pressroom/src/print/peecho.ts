import { fetchWithRetry } from "../http.js";
import { log } from "../log.js";
import type { Config, Secrets } from "../config.js";
import type { Issue } from "../types.js";
import type { PrintResult } from "./index.js";

/**
 * Peecho's print API places the order end to end, which is what you want if
 * you would rather approve a GitHub deployment than upload a file.
 *
 * Two things to know before you switch to it:
 *
 * 1. Peecho fetches the PDF from a URL — it does not accept an upload from
 *    here. Publish the built file somewhere reachable and set
 *    PUBLIC_ASSET_BASE to its base URL.
 * 2. The payload below follows the documented v3 order shape, but offering
 *    ids and the exact field names for your product are specific to your
 *    merchant account. Run `pressroom order --dry-run` first, compare the
 *    printed body against the API reference in your Peecho dashboard, and
 *    only then drop --dry-run. The default baseUrl is their test host, so a
 *    mistake costs nothing until you change it.
 */
export async function placePeechoOrder(
  issue: Issue,
  config: Config,
  secrets: Secrets,
  printPath: string,
  options: { dryRun: boolean },
): Promise<PrintResult> {
  const { peecho } = config.print;

  if (!secrets.peechoApiKey || !secrets.peechoMerchantId) {
    throw new Error(
      "PEECHO_API_KEY and PEECHO_MERCHANT_ID must be set to order through Peecho",
    );
  }
  if (!peecho.offeringId) {
    throw new Error("print.peecho.offeringId is not set in pressroom.config.json");
  }
  if (!secrets.publicAssetBase) {
    throw new Error(
      "PUBLIC_ASSET_BASE must point at a public HTTPS location holding the " +
        "built PDF — Peecho fetches the file rather than receiving an upload",
    );
  }

  const fileUrl = `${secrets.publicAssetBase.replace(/\/$/, "")}/${printPath.split("/").pop()}`;
  const shipping = peecho.shipping;

  const body = {
    merchantId: secrets.peechoMerchantId,
    offeringId: peecho.offeringId,
    currency: "GBP",
    reference: `${issue.masthead}-${issue.month}`,
    items: [
      {
        quantity: config.print.copies,
        numberOfPages: issue.pageCount,
        // First page is the cover, last page the back cover.
        contentUrl: fileUrl,
        title: `${issue.masthead} No. ${issue.number}`,
      },
    ],
    address: {
      name: shipping.name,
      addressLine1: shipping.address,
      city: shipping.city,
      postalCode: shipping.postcode,
      countryCode: shipping.countryCode,
    },
  };

  if (options.dryRun) {
    log.info("peecho dry run — this body would be posted:");
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return {
      vendor: "peecho",
      placed: false,
      requiresManualUpload: false,
      instructions: "Dry run only. Re-run without --dry-run to place the order.",
    };
  }

  const res = await fetchWithRetry(`${peecho.baseUrl}/rest/v3/order/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": secrets.peechoApiKey,
    },
    body: JSON.stringify(body),
    label: "peecho",
    retries: 2,
  });

  const result = (await res.json()) as { id?: string; orderId?: string };
  const reference = result.orderId ?? result.id;
  log.info(`peecho order placed: ${reference}`);

  return {
    vendor: "peecho",
    placed: true,
    requiresManualUpload: false,
    reference,
    instructions: `Order ${reference} is with the printer.`,
  };
}
