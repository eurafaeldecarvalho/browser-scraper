import { CDPClient, CDPError } from "../core/cdp-client";

export class ShadowRootAccessor {
  private _cdp: CDPClient;

  constructor(cdp: CDPClient) {
    this._cdp = cdp;
  }

  async describeNodeWithShadow({
    nodeId = null,
    objectId = null,
    depth = -1,
  }: {
    nodeId?: number | null;
    objectId?: string | null;
    depth?: number;
  } = {}): Promise<Record<string, any>> {
    const params: Record<string, unknown> = {
      depth,
      pierce: true,
    };

    if (nodeId) {
      params.nodeId = nodeId;
    } else if (objectId) {
      params.objectId = objectId;
    } else {
      throw new Error("Either node_id or object_id must be provided");
    }

    const result = await this._cdp.send("DOM.describeNode", params);
    return result.node ?? {};
  }

  async findClosedShadowRoots({ rootNode }: { rootNode: Record<string, any> }): Promise<number[]> {
    const shadow_roots: number[] = [];
    this._collect_shadow_roots(rootNode, shadow_roots);
    return shadow_roots;
  }

  private _collect_shadow_roots(node: Record<string, any>, results: number[]): void {
    for (const shadow_root of node.shadowRoots ?? []) {
      if (shadow_root.shadowRootType === "closed") {
        const backend_id = Number(shadow_root.backendNodeId ?? 0);
        if (backend_id) {
          results.push(backend_id);
        }
      }

      this._collect_shadow_roots(shadow_root, results);
    }

    for (const child of node.children ?? []) {
      this._collect_shadow_roots(child, results);
    }
  }

  async resolveShadowRoot({
    backendNodeId,
    contextId = null,
  }: {
    backendNodeId: number;
    contextId?: number | null;
  }): Promise<string | null> {
    try {
      const params: Record<string, unknown> = { backendNodeId };
      if (contextId) {
        params.executionContextId = contextId;
      }

      const result = await this._cdp.send("DOM.resolveNode", params);
      return result.object?.objectId ?? null;
    } catch (error) {
      if (error instanceof CDPError) {
        return null;
      }
      throw error;
    }
  }

  async querySelectorInShadow({ shadowObjectId, selector }: { shadowObjectId: string; selector: string }): Promise<string | null> {
    try {
      const result = await this._cdp.send("Runtime.callFunctionOn", {
        objectId: shadowObjectId,
        functionDeclaration: `
          function() {
            return this.querySelector(${JSON.stringify(selector)});
          }
        `,
        returnByValue: false,
      });

      return result.result?.objectId ?? null;
    } catch (error) {
      if (error instanceof CDPError) {
        return null;
      }
      throw error;
    }
  }

  async querySelectorAllInShadow({ shadowObjectId, selector }: { shadowObjectId: string; selector: string }): Promise<string[]> {
    try {
      const result = await this._cdp.send("Runtime.callFunctionOn", {
        objectId: shadowObjectId,
        functionDeclaration: `
          function() {
            return Array.from(this.querySelectorAll(${JSON.stringify(selector)}));
          }
        `,
        returnByValue: false,
      });

      const array_object_id = result.result?.objectId;
      if (!array_object_id) {
        return [];
      }

      const props = await this._cdp.send("Runtime.getProperties", {
        objectId: array_object_id,
        ownProperties: true,
      });

      const object_ids: string[] = [];
      for (const prop of props.result ?? []) {
        if (/^\d+$/.test(String(prop.name ?? "")) && prop.value?.objectId) {
          object_ids.push(prop.value.objectId);
        }
      }

      return object_ids;
    } catch (error) {
      if (error instanceof CDPError) {
        return [];
      }
      throw error;
    }
  }

  async findInAllShadowRoots({
    selector,
    rootNodeId = null,
  }: {
    selector: string;
    rootNodeId?: number | null;
  }): Promise<string | null> {
    let root: Record<string, any>;

    if (rootNodeId) {
      root = await this.describeNodeWithShadow({ nodeId: rootNodeId });
    } else {
      const doc_result = await this._cdp.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      root = doc_result.root ?? {};
    }

    const shadow_root_ids = await this.findClosedShadowRoots({ rootNode: root });
    for (const backend_id of shadow_root_ids) {
      const object_id = await this.resolveShadowRoot({ backendNodeId: backend_id });
      if (!object_id) {
        continue;
      }

      const element_object_id = await this.querySelectorInShadow({ shadowObjectId: object_id, selector });
      if (element_object_id) {
        return element_object_id;
      }
    }

    return null;
  }
}