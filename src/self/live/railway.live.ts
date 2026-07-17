import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeployModelBlock, DeployService } from "../domain/beacon-v2.domain.js";

const execFileAsync = promisify(execFile);

const RAILWAY_GQL = "https://backboard.railway.app/graphql/v2";

const PROJECT_SERVICES_QUERY = `
query project($id: String!) {
  project(id: $id) {
    services {
      edges {
        node {
          name
          id
          serviceInstances {
            edges {
              node {
                domains {
                  serviceDomain
                }
                latestDeployment {
                  id
                  status
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface RailwayGqlResponse {
  data?: {
    project?: {
      services?: {
        edges?: Array<{
          node?: {
            name?: string;
            id?: string;
            serviceInstances?: {
              edges?: Array<{
                node?: {
                  domains?: Array<{ serviceDomain?: string }>;
                  latestDeployment?: { id?: string; status?: string };
                };
              }>;
            };
          };
        }>;
      };
    };
  };
  errors?: unknown[];
}

export function parseRailwayFixture(raw: unknown): DeployModelBlock {
  const data = raw as {
    services?: Array<{ name: string; alias?: string; deployment_status?: string }>;
  };
  return {
    status: "verified",
    pattern: "vercel-for-indexers",
    alias_is_contract: true,
    immutable_deployments: true,
    services: (data.services ?? []).map((s) => ({
      name: s.name,
      alias: s.alias,
      deployment_status: s.deployment_status,
    })),
  };
}

function mapGqlToServices(body: RailwayGqlResponse): DeployService[] {
  const edges = body.data?.project?.services?.edges ?? [];
  const services: DeployService[] = [];
  for (const edge of edges) {
    const node = edge.node;
    if (!node?.name) continue;
    const instance = node.serviceInstances?.edges?.[0]?.node;
    const domain = instance?.domains?.[0]?.serviceDomain;
    services.push({
      name: node.name,
      id: node.id,
      alias: domain,
      deployment_status: instance?.latestDeployment?.status,
    });
  }
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchRailwayDeployment(): Promise<DeployModelBlock> {
  const token = process.env.RAILWAY_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!token || !projectId) {
    throw new Error("RAILWAY_TOKEN and RAILWAY_PROJECT_ID required for live deployment probe");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await /* @non-metadata-fetch Railway API */ fetch(RAILWAY_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: PROJECT_SERVICES_QUERY,
        variables: { id: projectId },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Railway GQL HTTP ${res.status}`);
    }
    const body = (await res.json()) as RailwayGqlResponse;
    if (body.errors?.length) {
      throw new Error(`Railway GQL errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
    }
    return {
      status: "verified",
      pattern: "vercel-for-indexers",
      alias_is_contract: true,
      immutable_deployments: true,
      services: mapGqlToServices(body),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRailwayViaCli(): Promise<DeployModelBlock> {
  const { stdout } = await execFileAsync("railway", ["status", "--json"], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    services?: Array<{ name: string; url?: string }>;
  };
  return {
    status: "verified",
    pattern: "vercel-for-indexers",
    alias_is_contract: true,
    immutable_deployments: true,
    services: (parsed.services ?? []).map((s) => ({
      name: s.name,
      alias: s.url,
    })),
  };
}
