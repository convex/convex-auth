import { join } from "node:path";
import { ConvexDeployment, type ConvexManagement } from "./convexApi.ts";
import { demoDomain, type Demo } from "./demos.ts";
import { warning } from "./log.ts";
import { deployWithStaticHosting, withStaticHosting } from "./staticHosting.ts";

export type DemoResult = {
  demo: Demo;
  deploymentName?: string;
  /** The URL where the demo is served. */
  url?: string;
  domainVerified?: boolean;
  error?: unknown;
};

/**
 * Deploys one demo:
 *
 * 1. Gets the prod deployment of the demo, or creates it.
 * 2. Registers the custom domain of the demo. When Convex verified its DNS
 *    records, makes it the `CONVEX_SITE_URL` of the deployment.
 * 3. Sets `SITE_URL` to the origin of the demo, and `RP_ID` to its domain.
 * 4. Builds the frontend, pushes the functions, and uploads the frontend.
 */
export async function deployDemo(options: {
  /** The function writes the progress of the deploy here. */
  result: DemoResult;
  management: ConvexManagement;
  projectId: number;
  repoRoot: string;
  parentDomain: string;
  deployKeyName: string;
}): Promise<void> {
  const { result, management, projectId, repoRoot, deployKeyName } = options;
  const { demo } = result;
  const domain = demoDomain(demo, options.parentDomain);

  const deployment = await management.ensureProdDeployment(
    projectId,
    demo.name,
  );
  result.deploymentName = deployment.name;
  console.log(
    `${deployment.created ? "Created" : "Found"} the deployment ${deployment.name}`,
  );

  const { verified, created } = await management.ensureSiteDomain(
    deployment.name,
    domain,
  );
  result.domainVerified = verified;
  if (created) {
    console.log(`Added the custom domain ${domain}`);
  }

  const deployKey = await management.createDeployKey(
    deployment.name,
    deployKeyName,
  );
  try {
    const api = new ConvexDeployment(deployment.url, deployKey);

    const domainUrl = `https://${domain}`;
    if (verified) {
      if ((await api.getSiteUrl()) !== domainUrl) {
        // Before the functions are pushed, so that they see the new value.
        await api.setSiteUrl(domainUrl);
        console.log(`Set CONVEX_SITE_URL to ${domainUrl}`);
      }
    } else {
      warning(
        `${domain} is not verified`,
        `Add the DNS records of ${domain} that the Convex dashboard shows (https://dashboard.convex.dev/d/${deployment.name}/settings). Until Convex verifies them, the demo is served at the .convex.site URL of the deployment, and CONVEX_SITE_URL keeps that URL.`,
      );
    }
    const siteUrl = await api.getSiteUrl();
    result.url = siteUrl;

    // The frontend is on the site URL, thus it is also the origin of the demo.
    // The examples use SITE_URL in their emailed links, as the allowed OAuth
    // redirect origin, and as the origin of the passkeys. The passkey examples
    // use RP_ID as the domain of the passkeys.
    const rpId = new URL(siteUrl).hostname;
    await api.setEnvironmentVariables({ SITE_URL: siteUrl, RP_ID: rpId });
    console.log(`Set SITE_URL to ${siteUrl} and RP_ID to ${rpId}`);

    const exampleDir = join(repoRoot, "examples", demo.example);
    await withStaticHosting(exampleDir, () =>
      deployWithStaticHosting(exampleDir, deployKey),
    );
  } finally {
    await management.deleteDeployKey(deployment.name, deployKeyName);
  }
}
