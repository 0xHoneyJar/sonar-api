const DEFAULT_TIMEOUT_MS = Number(process.env.SONAR_SELF_PROBE_TIMEOUT_MS ?? 30_000);

const QUERY_ROOT_INTROSPECT = `query {
  __schema {
    queryType {
      fields { name }
    }
  }
}`;

export interface QueryRootIntrospection {
  fields: string[];
}

export async function introspectQueryRoot(endpoint: string): Promise<QueryRootIntrospection> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY_ROOT_INTROSPECT }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`introspection HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const body = (await res.json()) as {
      errors?: unknown[];
      data?: { __schema?: { queryType?: { fields?: Array<{ name: string }> } } };
    };
    if (body.errors?.length) {
      throw new Error(`introspection errors: ${JSON.stringify(body.errors).slice(0, 200)}`);
    }
    const fields = body.data?.__schema?.queryType?.fields?.map((f) => f.name) ?? [];
    return { fields: [...fields].sort() };
  } finally {
    clearTimeout(timer);
  }
}

export function defaultGraphqlEndpoint(): string {
  return (
    process.env.SONAR_GRAPHQL_ENDPOINT ??
    "https://sonar.0xhoneyjar.xyz/v1/graphql"
  );
}

export function graphqlAliasFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "sonar.0xhoneyjar.xyz";
  }
}
