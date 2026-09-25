// lib/workflowParser.ts
// Parses the 句子互动 workflow JSON into renderable data structures

export interface ParsedNode {
    id: string;
    shape: string;
    name: string;
    category: 'trigger' | 'action' | 'calculation' | 'comment';
    type: string;
    position: { x: number; y: number };
    size: { width: number; height: number };
    data: any; // Added for the node details panel
    ports?: { items?: { id: string; group: string }[] };
    raw: Record<string, unknown>;

    // Optional payload summaries for different node types
    modelType?: string;
    systemPrompt?: string;
    template?: string;
    code?: string;
    branches?: { name: string; branchId: string }[];
    /** rule-center 默认分支(else)对应的端口 id，与 ports.items 中某项一致；缺失时为 undefined */
    defaultBranchId?: string;
    tagNames?: string;
    operation?: string;
    triggerType?: string;
    knowledgeBaseNames?: string[];
    outputFields?: string[];
}

export interface ParsedEdge {
    id: string;
    sourceId: string;
    sourcePort: string;
    targetId: string;
    targetPort: string;
}

export interface ParsedWorkflow {
    nodes: ParsedNode[];
    edges: ParsedEdge[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

export function isCanvasEdge(item: Record<string, unknown>): boolean {
    const shape = typeof item.shape === 'string' ? item.shape : '';
    return shape === 'custom-curve-edge' || shape === 'edge';
}

export function parseWorkflow(json: Record<string, unknown>): ParsedWorkflow {
    const canvas = (json.canvas || []) as Record<string, unknown>[];

    const nodes: ParsedNode[] = [];
    const edges: ParsedEdge[] = [];

    for (const item of canvas) {
        const shape = typeof item.shape === 'string' ? item.shape : 'unknown';

        if (isCanvasEdge(item)) {
            const source = asRecord(item.source);
            const target = asRecord(item.target);
            const sourceId = typeof source?.cell === 'string' ? source.cell : '';
            const targetId = typeof target?.cell === 'string' ? target.cell : '';
            if (!sourceId || !targetId) continue;

            const sourcePort = typeof source?.port === 'string' ? source.port : 'source';
            const targetPort = typeof target?.port === 'string' ? target.port : 'target';
            edges.push({
                id: (item.id as string) || `edge-${edges.length + 1}`,
                sourceId,
                sourcePort,
                targetId,
                targetPort,
            });
            continue;
        }

        // Everything else is a node
        const data = (item.data || {}) as Record<string, unknown>;
        const nodePayload = (data.nodePayload || {}) as Record<string, unknown>;
        const position = (item.position || { x: 0, y: 0 }) as { x: number; y: number };
        const size = (item.size || { width: 350, height: 100 }) as { width: number; height: number };
        const ports = item.ports as { items?: { id: string; group: string }[] } | undefined;

        const category = (data.category as string) || (shape === 'canvas-tool-comment-node' ? 'comment' : 'calculation');

        const node: ParsedNode = {
            id: item.id as string,
            shape,
            name: (data.name as string) || shape,
            category: category as ParsedNode['category'],
            type: (data.type as string) || shape,
            position,
            size,
            data,
            ports,
            raw: item,
        };

        // Extract shape-specific payload summaries
        switch (data.type || shape) {
            case 'llm-completion': {
                node.modelType = nodePayload.modelType as string;
                node.systemPrompt = nodePayload.systemPrompt as string;
                break;
            }
            case 'rule-center': {
                const branches = (nodePayload.branches || []) as { name: string; branchId: string }[];
                node.branches = branches.map(b => ({ name: b.name, branchId: b.branchId }));
                node.defaultBranchId = typeof nodePayload.defaultBranchId === 'string' ? nodePayload.defaultBranchId : undefined;
                break;
            }
            case 'javascript-code': {
                node.code = nodePayload.code as string;
                break;
            }
            case 'send-text-message': {
                node.template = nodePayload.template as string;
                break;
            }
            case 'tag-user': {
                node.tagNames = data.tagNames as string;
                node.operation = nodePayload.operation as string;
                break;
            }
            case 'canvas-event-action': {
                node.triggerType = nodePayload.triggerType as string;
                break;
            }
            case 'query-knowledge-base': {
                const selectKnowledge = (data.selectKnowledge || []) as { name: string }[];
                node.knowledgeBaseNames = selectKnowledge.map(k => k.name);
                break;
            }
        }

        // Extract output fields if present
        const outputTypes = data.outputTypes as { name: string }[] | undefined;
        if (outputTypes && Array.isArray(outputTypes)) {
            node.outputFields = outputTypes.map(o => o.name);
        }

        nodes.push(node);
    }

    return { nodes, edges };
}

/** Compute port positions based on node positions and port group (left/right) */
export function getPortPosition(
    node: ParsedNode,
    portId: string,
    portGroup: 'left' | 'right'
): { x: number; y: number } {
    const { position, size } = node;

    // Left port is always vertically centered
    if (portGroup === 'left') {
        // The dot is exactly on the left edge (translate-x-1/2 of 10px means it's centered on x-0)
        return { x: position.x, y: position.y + size.height / 2 };
    }

    // Right ports
    // The dot is centered directly on the right edge
    const rightX = position.x + size.width;

    // For rule-center, it might be a specific branch port
    if (node.type === 'rule-center' && node.branches && node.branches.length > 0) {
        // Find which branch index this port corresponds to
        const branchIndex = node.branches.findIndex(b => b.branchId === portId || portId.includes(b.branchId));
        if (branchIndex !== -1) {
            // Match the style in WorkflowNode: top: 64 + i * 20
            // Add 5px (half of 10px circle) to point to the exact vertical center of the port
            return { x: rightX, y: position.y + 64 + branchIndex * 20 + 5 };
        }

        // Fallback or default port maps to the default branch at the bottom
        if (portId === 'source' || portId.includes('default')) {
            return { x: rightX, y: position.y + 64 + node.branches.length * 20 + 5 };
        }
    }

    // Default center-right
    return { x: rightX, y: position.y + size.height / 2 };
}

/** Build a lookup map: portId → { nodeId, group } */
export function buildPortMap(
    nodes: ParsedNode[],
    canvasItems: Record<string, unknown>[]
): Map<string, { nodeId: string; group: 'left' | 'right' }> {
    const map = new Map<string, { nodeId: string; group: 'left' | 'right' }>();

    for (const item of canvasItems) {
        if (isCanvasEdge(item)) continue;
        const id = item.id as string;
        const ports = item.ports as { items?: { id: string; group: string }[] } | undefined;
        if (!ports?.items) continue;

        for (const port of ports.items) {
            map.set(port.id, { nodeId: id, group: port.group as 'left' | 'right' });
        }
    }

    return map;
}

/** Resolve edge endpoints to pixel coordinates */
export interface ResolvedEdge {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export function resolveEdges(
    edges: ParsedEdge[],
    nodes: ParsedNode[],
    portMap: Map<string, { nodeId: string; group: 'left' | 'right' }>
): ResolvedEdge[] {
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const resolved: ResolvedEdge[] = [];

    for (const edge of edges) {
        const sourceInfo = portMap.get(edge.sourcePort);
        const targetInfo = portMap.get(edge.targetPort);
        const sourceNode = nodeMap.get(sourceInfo?.nodeId ?? edge.sourceId);
        const targetNode = nodeMap.get(targetInfo?.nodeId ?? edge.targetId);
        if (!sourceNode || !targetNode) continue;

        const start = getPortPosition(sourceNode, edge.sourcePort, sourceInfo?.group ?? 'right');
        const end = getPortPosition(targetNode, edge.targetPort, targetInfo?.group ?? 'left');

        resolved.push({ id: edge.id, x1: start.x, y1: start.y, x2: end.x, y2: end.y });
    }

    return resolved;
}
