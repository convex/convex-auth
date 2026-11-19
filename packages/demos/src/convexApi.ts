import {
  createDeploymentClient,
  createManagementClient,
} from "@convex-dev/platform";

type ManagementClient = ReturnType<typeof createManagementClient>;
type DeploymentClient = ReturnType<typeof createDeploymentClient>;

/** The result of an `openapi-fetch` call. */
type ApiResult = { data?: unknown; error?: unknown; response: Response };

/** Throws with the error of the API if the call failed. */
function check(what: string, result: ApiResult): void {
  if (result.error !== undefined || !result.response.ok) {
    throw new Error(
      `${what} failed (HTTP ${result.response.status}): ${JSON.stringify(result.error)}`,
    );
  }
}

/** Returns the data of a call, or throws with the error of the API. */
function unwrap<R extends ApiResult>(
  what: string,
  result: R,
): NonNullable<R["data"]> {
  check(what, result);
  if (result.data == null) {
    throw new Error(`${what} returned no data`);
  }
  return result.data as NonNullable<R["data"]>;
}

function isCloud<D extends { kind: string }>(
  deployment: D,
): deployment is Extract<D, { kind: "cloud" }> {
  return deployment.kind === "cloud";
}

/**
 * The calls to the Convex Management API that the demos need. The access
 * token must be a team access token of the team that holds the demos.
 */
export class ConvexManagement {
  private client: ManagementClient;

  constructor(
    accessToken: string,
    private teamId: number,
  ) {
    this.client = createManagementClient(accessToken);
  }

  /** Returns the project with this slug. Creates it if it does not exist. */
  async ensureProject(slug: string): Promise<{ id: number; created: boolean }> {
    const existing = await this.client.GET(
      "/teams/{team_id_or_slug}/projects/{project_slug}",
      {
        params: {
          path: { team_id_or_slug: String(this.teamId), project_slug: slug },
        },
      },
    );
    if (existing.response.status !== 404) {
      const project = unwrap(`Get the project "${slug}"`, existing);
      return { id: project.id, created: false };
    }
    const created = unwrap(
      `Create the project "${slug}"`,
      await this.client.POST("/teams/{team_id}/create_project", {
        params: { path: { team_id: this.teamId } },
        body: { projectName: slug },
      }),
    );
    if (created.slug !== slug) {
      throw new Error(
        `Convex created the project with the slug "${created.slug}", not "${slug}". Rename it in the dashboard.`,
      );
    }
    return { id: created.id, created: true };
  }

  async listProdDeployments(projectId: number) {
    const deployments = unwrap(
      "List the deployments",
      await this.client.GET("/projects/{project_id}/list_deployments", {
        params: { path: { project_id: projectId } },
      }),
    );
    return deployments
      .filter(isCloud)
      .filter((deployment) => deployment.deploymentType === "prod");
  }

  /**
   * Returns the prod deployment with this reference. Creates it if it does not
   * exist. A new deployment gets the default environment variables of the
   * project.
   */
  async ensureProdDeployment(
    projectId: number,
    reference: string,
  ): Promise<{ name: string; url: string; created: boolean }> {
    const existing = (await this.listProdDeployments(projectId)).find(
      (deployment) => deployment.reference === reference,
    );
    if (existing !== undefined) {
      return {
        name: existing.name,
        url: existing.deploymentUrl,
        created: false,
      };
    }
    const created = unwrap(
      `Create the deployment "${reference}"`,
      await this.client.POST("/projects/{project_id}/create_deployment", {
        params: { path: { project_id: projectId } },
        body: { type: "prod", reference },
      }),
    );
    if (!isCloud(created)) {
      throw new Error(`Convex created a ${created.kind} deployment`);
    }
    return { name: created.name, url: created.deploymentUrl, created: true };
  }

  async createDeployKey(deploymentName: string, keyName: string) {
    const { deployKey } = unwrap(
      "Create a deploy key",
      await this.client.POST(
        "/deployments/{deployment_name}/create_deploy_key",
        {
          params: { path: { deployment_name: deploymentName } },
          body: { name: keyName },
        },
      ),
    );
    return deployKey;
  }

  async deleteDeployKey(deploymentName: string, keyName: string) {
    check(
      "Delete the deploy key",
      await this.client.POST(
        "/deployments/{deployment_name}/delete_deploy_key",
        {
          params: { path: { deployment_name: deploymentName } },
          body: { id: keyName },
        },
      ),
    );
  }

  /**
   * Registers the domain for the HTTP actions (`convex.site`) of the
   * deployment, if it is not registered. Returns whether Convex verified the
   * DNS records of the domain.
   */
  async ensureSiteDomain(
    deploymentName: string,
    domain: string,
  ): Promise<{ verified: boolean; created: boolean }> {
    const { domains } = unwrap(
      "List the custom domains",
      await this.client.GET("/deployments/{deployment_name}/custom_domains", {
        params: { path: { deployment_name: deploymentName } },
      }),
    );
    const existing = domains.find(
      (d) => d.domain === domain && d.requestDestination === "convexSite",
    );
    if (existing !== undefined) {
      return {
        verified: existing.verificationTime != null,
        created: false,
      };
    }
    check(
      `Add the custom domain ${domain}`,
      await this.client.POST(
        "/deployments/{deployment_name}/create_custom_domain",
        {
          params: { path: { deployment_name: deploymentName } },
          body: { requestDestination: "convexSite", domain },
        },
      ),
    );
    return { verified: false, created: true };
  }
}

/** The calls to the API of one deployment, with a deploy key. */
export class ConvexDeployment {
  private client: DeploymentClient;

  constructor(deploymentUrl: string, deployKey: string) {
    this.client = createDeploymentClient(deploymentUrl, deployKey);
  }

  async setEnvironmentVariables(vars: Record<string, string>) {
    const changes = Object.entries(vars).map(([name, value]) => ({
      name,
      value,
    }));
    if (changes.length === 0) {
      return;
    }
    check(
      "Set the environment variables",
      await this.client.POST("/update_environment_variables", {
        body: { changes },
      }),
    );
  }

  async getSiteUrl(): Promise<string> {
    const urls = unwrap(
      "Get the canonical URLs",
      await this.client.GET("/get_canonical_urls"),
    );
    return urls.convexSiteUrl;
  }

  /**
   * Sets the canonical URL of the HTTP actions of the deployment. This is the
   * value of `CONVEX_SITE_URL` in the functions, thus the OAuth methods use it
   * in their redirect URIs.
   */
  async setSiteUrl(url: string) {
    check(
      "Set the canonical site URL",
      await this.client.POST("/update_canonical_url", {
        body: { requestDestination: "convexSite", url },
      }),
    );
  }
}
