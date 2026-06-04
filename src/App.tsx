import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Engine, Render, Runner, Composite, Bodies, Constraint, Events, Vector, Body } from 'matter-js';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Grid, Hammer, Info, Play, RefreshCw, Trash2, ShieldAlert, CircleDot, Activity, Undo2, Redo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Position = { x: number; y: number };
type Node = Position & { id: string; isAnchor?: boolean; label?: string };
type Material = 'wood';
type Member = { id: string; nodeA: string; nodeB: string; material: Material; broken?: boolean; currentStrain?: number };

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 500;
const GRID_SIZE = 10;

const ANCHOR_L_ID = 'anchor_l';
const ANCHOR_R_ID = 'anchor_r';

const DEFAULT_NODES: Node[] = [
  { id: ANCHOR_L_ID, x: 200, y: 400, isAnchor: true, label: 'L' },
  { id: ANCHOR_R_ID, x: 600, y: 400, isAnchor: true, label: 'R' },
];

const MATERIAL_PROPS = {
  wood: { color: 'var(--color-wood)', tensionLim: 0.12, compLim: 0.10, linearDensity: 0.2, label: '松木', thickness: 6 },
};

type Tool = 'node' | 'wood' | 'delete';

const calculateBridgeWeight = (currentNodes: Node[], currentMembers: Member[]) => {
  let weight = 0;
  currentMembers.forEach(m => {
    const nA = currentNodes.find(n => n.id === m.nodeA);
    const nB = currentNodes.find(n => n.id === m.nodeB);
    if (!nA || !nB) return;
    const dist = Math.sqrt((nA.x - nB.x)**2 + (nA.y - nB.y)**2);
    // distance is in pixels (approx cm if 10px = 1cm? The load text said length / 10). Let's use the same:
    // length in cm = dist / 10
    weight += (dist / 10) * MATERIAL_PROPS[m.material].linearDensity;
  });
  return Math.round(weight);
};

export default function App() {
  const [nodes, setNodes] = useState<Node[]>(DEFAULT_NODES);
  const [members, setMembers] = useState<Member[]>([]);
  const [tool, setTool] = useState<Tool>('wood');
  const [isTesting, setIsTesting] = useState(false);
  const [hoverPos, setHoverPos] = useState<Position | null>(null);
  const [dragStartNode, setDragStartNode] = useState<string | null>(null);
  const [dragStartPos, setDragStartPos] = useState<Position | null>(null);
  const [dragCurrentPos, setDragCurrentPos] = useState<Position | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);
  const [loadPos, setLoadPos] = useState<{x: number, y: number, angle: number} | null>(null);
  
  const [testResult, setTestResult] = useState<{ status: 'running'|'success'|'failed'; message?: string } | null>(null);
  const [testStats, setTestStats] = useState<{ currentLoad: number, broken: boolean, bridgeWeight: number }>({ currentLoad: 0, broken: false, bridgeWeight: 0 });
  const engineRef = useRef<Engine | null>(null);
  const runnerRef = useRef<Runner | null>(null);
  const animFrameRef = useRef<number>();
  const currentLoadRef = useRef<number>(0);
  const loadNodeIdRef = useRef<string | null>(null);
  const testBrokenRef = useRef<boolean>(false);

  const [historyPast, setHistoryPast] = useState<{nodes: Node[], members: Member[]}[]>([]);
  const [historyFuture, setHistoryFuture] = useState<{nodes: Node[], members: Member[]}[]>([]);

  const saveHistory = () => {
    setHistoryPast(prev => [...prev, { nodes: [...nodes], members: [...members] }]);
    setHistoryFuture([]);
  };

  const undo = () => {
    if (historyPast.length === 0) return;
    const previous = historyPast[historyPast.length - 1];
    setHistoryPast(historyPast.slice(0, historyPast.length - 1));
    setHistoryFuture([{ nodes: [...nodes], members: [...members] }, ...historyFuture]);
    setNodes(previous.nodes);
    setMembers(previous.members);
  };

  const redo = () => {
    if (historyFuture.length === 0) return;
    const next = historyFuture[0];
    setHistoryFuture(historyFuture.slice(1));
    setHistoryPast([...historyPast, { nodes: [...nodes], members: [...members] }]);
    setNodes(next.nodes);
    setMembers(next.members);
  };

  const snapToGrid = (x: number, y: number): Position => {
    return {
      x: Math.round(x / GRID_SIZE) * GRID_SIZE,
      y: Math.round(y / GRID_SIZE) * GRID_SIZE,
    };
  };

  const getDistance = (p1: Position, p2: Position) => Math.sqrt((p1.x - p2.x)**2 + (p1.y - p2.y)**2);

  const getMouseCoords = (e: React.MouseEvent<SVGSVGElement>): Position => {
    const svg = e.currentTarget;
    let pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (ctm) {
      pt = pt.matrixTransform(ctm.inverse());
    } else {
      const rect = svg.getBoundingClientRect();
      pt.x = e.clientX - rect.left;
      pt.y = e.clientY - rect.top;
    }
    return { x: pt.x, y: pt.y };
  };

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isTesting) return;
    const coords = getMouseCoords(e);
    const snapped = snapToGrid(coords.x, coords.y);
    setHoverPos(snapped);
    // Snap the visual line preview to the grid for easier alignment
    setDragCurrentPos(snapped);
  };

  const handleMouseLeave = () => {
    setHoverPos(null);
    setDragStartNode(null);
    setDragStartPos(null);
    setDragCurrentPos(null);
  };

  const getNodeAt = (p: Position) => nodes.find(n => getDistance(n, p) < 10);
  const getMemberAt = (p: Position) => {
    for (const m of members) {
      const nA = nodes.find(n => n.id === m.nodeA);
      const nB = nodes.find(n => n.id === m.nodeB);
      if (!nA || !nB) continue;
      // Distance from point to line segment
      const l2 = (nA.x - nB.x)**2 + (nA.y - nB.y)**2;
      if (l2 === 0) continue;
      let t = ((p.x - nA.x) * (nB.x - nA.x) + (p.y - nA.y) * (nB.y - nA.y)) / l2;
      t = Math.max(0, Math.min(1, t));
      const proj = { x: nA.x + t * (nB.x - nA.x), y: nA.y + t * (nB.y - nA.y) };
      if (getDistance(p, proj) < 12) return m;
    }
    return null;
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (isTesting) return;
    const coords = getMouseCoords(e);
    const snapped = snapToGrid(coords.x, coords.y);

    if (tool === 'delete') {
      let clickedNode = nodes.find(n => getDistance(n, coords) < 15) || getNodeAt(snapped);
      
      if (clickedNode && !clickedNode.isAnchor) {
        saveHistory();
        setMembers(ms => ms.filter(m => m.nodeA !== clickedNode.id && m.nodeB !== clickedNode.id));
        setNodes(ns => ns.filter(n => n.id !== clickedNode.id));
      } else {
        const clickedMember = getMemberAt(coords);
        if (clickedMember) {
          saveHistory();
          setMembers(ms => ms.filter(m => m.id !== clickedMember.id));
        }
      }
      return;
    }

    if (tool === 'node') {
      const clickedNode = getNodeAt(snapped);
      if (clickedNode) return; // already a node here
      saveHistory();
      setNodes([...nodes, { id: 'n_' + Date.now(), x: snapped.x, y: snapped.y }]);
      return;
    }

    if (tool === 'wood') {
      let clickedNode = getNodeAt(snapped);
      
      if (!dragStartNode) {
        // First click: Start point
        saveHistory();
        if (!clickedNode) {
          clickedNode = { id: 'n_' + Date.now(), x: snapped.x, y: snapped.y };
          setNodes(ns => [...ns, clickedNode!]);
        }
        setDragStartNode(clickedNode.id);
        setDragStartPos({ x: clickedNode.x, y: clickedNode.y });
        setDragCurrentPos(coords);
      } else {
        // Second click: End point
        if (clickedNode && clickedNode.id === dragStartNode) {
          // Cancel if clicked on the same starting node
          setDragStartNode(null);
          setDragStartPos(null);
          setDragCurrentPos(null);
          return;
        }

        saveHistory();
        let endNode = clickedNode;
        if (!endNode) {
          endNode = { id: 'n_' + Date.now() + '_end', x: snapped.x, y: snapped.y };
          setNodes(ns => [...ns, endNode!]);
        }

        setMembers(prev => {
          const exists = prev.some(m => 
            (m.nodeA === dragStartNode && m.nodeB === endNode!.id) || 
            (m.nodeB === dragStartNode && m.nodeA === endNode!.id)
          );
          if (!exists) {
            return [...prev, {
              id: 'm_' + Date.now(),
              nodeA: dragStartNode,
              nodeB: endNode!.id,
              material: 'wood'
            }];
          }
          return prev;
        });
        
        // Complete the placement and reset dragging state
        setDragStartNode(null);
        setDragStartPos(null);
        setDragCurrentPos(null);
      }
    }
  };

  const validateStructure = () => {
    // 1. Spans correctly? BFS from left anchor to right anchor
    const adj = new Map<string, string[]>();
    nodes.forEach(n => adj.set(n.id, []));
    members.forEach(m => {
      adj.get(m.nodeA)?.push(m.nodeB);
      adj.get(m.nodeB)?.push(m.nodeA);
    });

    const visited = new Set<string>();
    const queue = [ANCHOR_L_ID];
    visited.add(ANCHOR_L_ID);
    let reached = false;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === ANCHOR_R_ID) reached = true;
      adj.get(cur)?.forEach(nxt => {
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      });
    }

    // 2. Height requirement >= 60px (y <= 340) for the actual truss
    const usedNodeIds = new Set<string>();
    members.forEach(m => {
       usedNodeIds.add(m.nodeA);
       usedNodeIds.add(m.nodeB);
    });
    let trussMaxHeight = 400;
    usedNodeIds.forEach(id => {
       const n = nodes.find(n => n.id === id);
       if (n && n.y < trussMaxHeight) trussMaxHeight = n.y;
    });
    const heightPassed = trussMaxHeight <= 340 && members.length > 0;

    let errorMessage = null;
    if (!reached) {
      errorMessage = "結構未連接！請確保從左岸到右岸有完整的路徑。";
    } else if (!heightPassed) {
      errorMessage = "結構高度不足！木材桁架必須有一處超過 6 公分高度 (高度輔助線)。";
    }

    return { isConnected: reached, heightPassed, errorMessage };
  };

  const analyzeStructure = (brokenMembers: Member[], reason: 'load_fell' | 'member_broke') => {
    if (brokenMembers.length > 0) {
      const tensionBreaks = brokenMembers.filter(m => m.currentStrain && m.currentStrain > 0);
      const compBreaks = brokenMembers.filter(m => m.currentStrain && m.currentStrain < 0);
      
      let feedback = [];
      if (tensionBreaks.length > 0) {
        feedback.push("底部或外側拉力過大發生斷裂，由於材料限定木材，建議增加橋樑高度或增加桿件來減緩單點拉力。");
      }
      if (compBreaks.length > 0) {
        feedback.push("上方弦桿承受不住壓力而崩潰（挫曲），建議增加上方結構的高度或將受壓區域改為三角形以分散壓力。");
      }
      return feedback.join(" ");
    } else if (reason === 'load_fell') {
      return "橋樑產生劇烈形變失效。推測缺乏三角形分力結構，請確保所有網格皆由三角形組成。";
    }
    return "結構失效。";
  };

  const startTest = () => {
    const { errorMessage } = validateStructure();
    if (errorMessage) {
      setValidationMsg(errorMessage);
      return;
    }
    setValidationMsg(null);
    setIsTesting(true);
    setTestResult({ status: 'running' });

    // Find bottom-most central node to apply load
    let targetNodeId = null;
    let minDiff = Infinity;
    let maxDepth = -Infinity;
    nodes.forEach(n => {
      if (n.isAnchor) return;
      const diffX = Math.abs(n.x - 400);
      if (n.y > maxDepth - 20) {
        if (n.y > maxDepth + 20) {
          maxDepth = n.y;
          minDiff = diffX;
          targetNodeId = n.id;
        } else if (diffX < minDiff) {
          minDiff = diffX;
          targetNodeId = n.id;
        }
      }
    });
    if (!targetNodeId && nodes.filter(n => !n.isAnchor).length > 0) {
       targetNodeId = nodes.find(n => !n.isAnchor)!.id;
    }
    loadNodeIdRef.current = targetNodeId;
    currentLoadRef.current = 0;
    testBrokenRef.current = false;
    // Calculate weight before test runs
    const bridgeWeightCalc = calculateBridgeWeight(nodes, members);
    setTestStats({ currentLoad: 0, broken: false, bridgeWeight: bridgeWeightCalc });

    // Initialize Matter.js
    const engine = Engine.create({ positionIterations: 50, velocityIterations: 50 });
    engineRef.current = engine;
    
    // Create bodies mapping
    const bodyMap: Record<string, Body> = {};
    const nodeMasses = new Map<string, number>();
    nodes.forEach(n => nodeMasses.set(n.id, 0.5));
    members.forEach(m => {
      const nA = nodes.find(n => n.id === m.nodeA)!;
      const nB = nodes.find(n => n.id === m.nodeB)!;
      const massHalf = ((getDistance(nA, nB) / 10) * MATERIAL_PROPS[m.material].linearDensity) / 2;
      nodeMasses.set(m.nodeA, nodeMasses.get(m.nodeA)! + massHalf);
      nodeMasses.set(m.nodeB, nodeMasses.get(m.nodeB)! + massHalf);
    });

    const matterNodes = nodes.map(n => {
      const massObj = n.isAnchor ? {} : { mass: nodeMasses.get(n.id) };
      const b = Bodies.circle(n.x, n.y, 6, {
        isStatic: n.isAnchor,
        friction: 0.8,
        restitution: 0.1,
        ...massObj,
        collisionFilter: { group: -1 }, // nodes don't collide
        plugin: { id: n.id }
      });
      bodyMap[n.id] = b;
      return b;
    });

    Composite.add(engine.world, matterNodes);

    // Create constraints
    const renderMembers = [...members.map(m => ({...m, broken: false, currentStrain: 0}))];
    const constraintsPairs: { constraint: Constraint, member: typeof renderMembers[0], origL: number }[] = [];

    renderMembers.forEach(m => {
      const bA = bodyMap[m.nodeA];
      const bB = bodyMap[m.nodeB];
      if (!bA || !bB) return;
      
      const dist = getDistance(bA.position, bB.position);
      const c = Constraint.create({
        bodyA: bA,
        bodyB: bB,
        stiffness: 1, 
        length: dist,
        render: { visible: false }
      });
      constraintsPairs.push({ constraint: c, member: m, origL: dist });
      Composite.add(engine.world, c);
    });

    // Ground for bridge to fall away if bridge breaks
    const ground = Bodies.rectangle(400, 600, 1000, 50, { isStatic: true });
    Composite.add(engine.world, ground);

    const runner = Runner.create();
    runnerRef.current = runner;
    Runner.run(runner, engine);

    let failed = false;

    // Load loop
    Events.on(engine, 'beforeUpdate', () => {
      if (failed) return;
      
      currentLoadRef.current += 10;
      const F = currentLoadRef.current * engine.gravity.y * engine.gravity.scale;
      const loadBody = bodyMap[loadNodeIdRef.current!];
      if (loadBody) {
          Body.applyForce(loadBody, loadBody.position, { x: 0, y: F });
      }

      if (engine.timing.timestamp % 100 < 20) {
        setTestStats(prev => ({ ...prev, currentLoad: currentLoadRef.current }));
      }
    });

    Events.on(engine, 'afterUpdate', () => {
      if (failed) return;

      let newlyBroken = false;
      const bMembers = renderMembers;

      constraintsPairs.forEach(p => {
        if (p.member.broken) return;
        const dist = getDistance(p.constraint.bodyA.position, p.constraint.bodyB.position);
        const strain = (dist - p.origL) / p.origL;
        p.member.currentStrain = strain;

        const opt = MATERIAL_PROPS[p.member.material];
        if (strain > opt.tensionLim || strain < -opt.compLim) {
          p.member.broken = true;
          newlyBroken = true;
          Composite.remove(engine.world, p.constraint);
        }
      });

      // Update React state for rendering
      const newNodesNodes = nodes.map(n => {
        if (bodyMap[n.id]) {
          return { ...n, x: bodyMap[n.id].position.x, y: bodyMap[n.id].position.y };
        }
        return n;
      });
      setNodes(newNodesNodes);
      setMembers([...bMembers]);

      let fallen = false;
      Object.values(bodyMap).forEach((body) => {
        if (body.position.y > 450) fallen = true;
      });

      if (fallen || newlyBroken) {
        failed = true;
        testBrokenRef.current = true;
        Runner.stop(runner);
        const brokenMs = renderMembers.filter(m => m.broken);
        const reason = brokenMs.length > 0 ? 'member_broke' : 'load_fell';
        const advice = analyzeStructure(brokenMs, reason);
        setTestResult({ status: 'failed', message: advice });
        setTestStats(prev => ({ ...prev, currentLoad: currentLoadRef.current, broken: true }));
      }
    });
  };

  const resetDesign = () => {
    setIsTesting(false);
    setTestResult(null);
    setValidationMsg(null);
    setLoadPos(null);
    if (runnerRef.current) Runner.stop(runnerRef.current);
    if (engineRef.current) Engine.clear(engineRef.current);
  };

  const clearAll = () => {
    saveHistory();
    resetDesign();
    setNodes(DEFAULT_NODES);
    setMembers([]);
  };

  // We need to keep a copy of original design to restore after test
  const [designBackup, setDesignBackup] = useState<{nodes: Node[], members: Member[]} | null>(null);

  const handleStartTest = () => {
    setDesignBackup({ nodes: JSON.parse(JSON.stringify(nodes)), members: JSON.parse(JSON.stringify(members)) });
    startTest();
  };

  const handleStopTest = () => {
    if (runnerRef.current) Runner.stop(runnerRef.current);
    if (engineRef.current) Engine.clear(engineRef.current);
    if (designBackup) {
      setNodes(designBackup.nodes);
      setMembers(designBackup.members);
    }
    setIsTesting(false);
    setTestResult(null);
    setLoadPos(null);
  };

  // Render SVG elements
  return (
    <div className="min-h-screen bg-bg text-text-primary flex flex-col p-4 font-sans">
      <div className="max-w-6xl mx-auto w-full flex flex-col gap-4">
        
        <header className="flex justify-between items-center bg-panel p-4 rounded-xl shadow-sm border border-white/5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-accent logo">STRUCTURE LAB / 桁架模擬器</h1>
            <p className="text-text-muted text-sm mt-1">工程設計流程 (EDP) v2.4.0</p>
          </div>
          <div className="flex gap-2">
            {!isTesting ? (
              <>
                <Button variant="outline" onClick={clearAll} className="bg-panel border-white/5 text-text-primary hover:bg-white/10 hover:text-white"><Trash2 className="w-4 h-4 mr-2" />清空計畫</Button>
                <Button onClick={handleStartTest} className="bg-accent text-black hover:bg-accent/80 font-bold">
                  <Play className="w-4 h-4 mr-2" /> 進行負載測試
                </Button>
              </>
            ) : (
              <Button onClick={handleStopTest} className="bg-danger text-white hover:bg-danger/80 font-bold">
                <RefreshCw className="w-4 h-4 mr-2" /> 停止測試
              </Button>
            )}
          </div>
        </header>

        <div className="flex gap-4">
          {/* Main Workspace */}
          <div className="flex-1 bg-panel rounded-xl shadow-sm border border-white/5 overflow-hidden relative" style={{ backgroundImage: 'radial-gradient(circle at center, #1a1c23 0%, var(--color-bg) 100%)', height: CANVAS_HEIGHT }}>
            {/* Toolbar Overlay */}
            {!isTesting && (
              <div className="absolute top-4 left-4 bg-panel/90 backdrop-blur shadow-sm p-1 rounded-lg border border-white/5 flex flex-col gap-1 z-10 w-32">
                <div className="text-xs font-semibold text-text-muted mb-1 px-2 pt-1">建造工具</div>
                <Button variant="ghost" size="sm" className={cn("justify-start", tool === 'node' ? "bg-accent/10 border border-accent/30 text-accent" : "text-text-primary hover:bg-white/5")} onClick={() => setTool('node')}>
                  <CircleDot className="w-4 h-4 mr-2" /> 節點
                </Button>
                <Button variant="ghost" size="sm" className={cn("justify-start", tool === 'wood' ? "bg-accent/10 border border-accent/30 text-accent" : "text-text-primary hover:bg-white/5")} onClick={() => setTool('wood')}>
                   <div className="w-4 h-1 bg-[var(--color-wood)] rounded-full mr-2" /> 木材
                </Button>
                <Button variant="ghost" size="sm" className={cn("justify-start hover:text-danger", tool === 'delete' ? "bg-danger/10 border border-danger/30 text-danger" : "text-danger/70 hover:bg-white/5")} onClick={() => setTool('delete')}>
                  <Hammer className="w-4 h-4 mr-2" /> 拆除
                </Button>
                
                {/* Undo / Redo */}
                <div className="flex gap-1 mt-2 border-t border-white/5 pt-2">
                  <Button variant="ghost" size="sm" className="flex-1 bg-panel/50 hover:bg-white/10 text-text-primary disabled:opacity-30 disabled:hover:bg-transparent" onClick={undo} disabled={historyPast.length === 0} title="返回上一動">
                    <Undo2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="flex-1 bg-panel/50 hover:bg-white/10 text-text-primary disabled:opacity-30 disabled:hover:bg-transparent" onClick={redo} disabled={historyFuture.length === 0} title="取消返回 (Redo)">
                    <Redo2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            <svg 
              className={cn("w-full h-full", isTesting ? "cursor-default" : (tool === 'delete' ? 'cursor-not-allowed' : 'cursor-crosshair'))}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
              onClick={handleClick}
              viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
            >
              <defs>
                <pattern id="grid" width={GRID_SIZE} height={GRID_SIZE} patternUnits="userSpaceOnUse">
                  <path d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1"/>
                  <circle cx="0" cy="0" r="1" fill="rgba(255,255,255,0.2)" />
                  <circle cx={GRID_SIZE} cy="0" r="1" fill="rgba(255,255,255,0.2)" />
                  <circle cx="0" cy={GRID_SIZE} r="1" fill="rgba(255,255,255,0.2)" />
                  <circle cx={GRID_SIZE} cy={GRID_SIZE} r="1" fill="rgba(255,255,255,0.2)" />
                </pattern>
                
                {/* Striped pattern for ground */}
                <pattern id="stripes" width="20" height="20" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
                  <line x1="0" y1="0" x2="0" y2="20" stroke="rgba(255,255,255,0.05)" strokeWidth="10" />
                </pattern>
              </defs>
              
              <rect width="100%" height="100%" fill="url(#grid)" />

              {/* Ground and River */}
              {/* Left Ground */}
              <rect x="0" y="400" width="200" height="100" fill="url(#stripes)" />
              <line x1="0" y1="400" x2="200" y2="400" stroke="var(--color-panel)" strokeWidth="4" />
              
              {/* Right Ground */}
              <rect x="600" y="400" width="200" height="100" fill="url(#stripes)" />
              <line x1="600" y1="400" x2="800" y2="400" stroke="var(--color-panel)" strokeWidth="4" />

              {/* River Text */}
              <text x="400" y="460" textAnchor="middle" className="font-bold text-xl tracking-widest opacity-20" fill="var(--color-text-muted)">~ R I V E R ~</text>

              {/* Rulers */}
              <g className="ruler">
                {/* 40cm Span Ruler */}
                <line x1="200" y1="480" x2="600" y2="480" stroke="var(--color-accent)" strokeWidth="1" strokeDasharray="4 4"/>
                <line x1="200" y1="475" x2="200" y2="485" stroke="var(--color-accent)" strokeWidth="2" />
                <line x1="600" y1="475" x2="600" y2="485" stroke="var(--color-accent)" strokeWidth="2" />
                <text x="400" y="470" fontSize="12" fill="var(--color-accent)" textAnchor="middle">跨距 40cm (400px)</text>
                
                {/* 6cm Height Ruler (Y=340) */}
                <line x1="0" y1="340" x2="800" y2="340" stroke="var(--color-text-muted)" strokeWidth="1" strokeDasharray="6 4"/>
                <text x="700" y="330" fontSize="10" fill="var(--color-text-muted)" textAnchor="middle">最低高度限制 6cm (60px)</text>
              </g>

              {/* Members */}
              {members.map(m => {
                const nA = nodes.find(n => n.id === m.nodeA);
                const nB = nodes.find(n => n.id === m.nodeB);
                if (!nA || !nB) return null;
                const props = MATERIAL_PROPS[m.material];
                
                let strokeColor = props.color;
                if (m.broken) {
                  strokeColor = 'var(--color-danger)'; // Red broken
                } else if (isTesting && m.currentStrain !== undefined) {
                  // Colorization: Tension(>0) -> Red, Comp(<0) -> Blue
                  const intensity = Math.min(1, Math.abs(m.currentStrain) / (m.currentStrain > 0 ? props.tensionLim : props.compLim));
                  if (intensity > 0.1) {
                     // VERY rough interpolation
                     strokeColor = m.currentStrain > 0 ? `rgba(255, 77, 77, ${intensity})` : `rgba(0, 209, 255, ${intensity})`;
                     if (intensity < 0.6) strokeColor = props.color; // blend fallback just display base
                  }
                }

                return (
                  <line 
                    key={m.id} 
                    x1={nA.x} y1={nA.y} 
                    x2={nB.x} y2={nB.y} 
                    stroke={strokeColor} 
                    strokeWidth={props.thickness}
                    strokeLinecap="round"
                    className={cn("transition-colors duration-200", m.broken ? "opacity-30" : "opacity-100", (!isTesting && hoverPos && tool === 'delete') ? "hover:stroke-red-500" : "")}
                  />
                );
              })}

              {/* Draw Dragging Member */}
              {(tool === 'wood') && dragStartNode && dragStartPos && dragCurrentPos && (() => {
                const lineLength = getDistance(dragStartPos, dragCurrentPos);
                const cmLength = (lineLength / 10).toFixed(1);
                const midX = (dragStartPos.x + dragCurrentPos.x) / 2;
                const midY = (dragStartPos.y + dragCurrentPos.y) / 2;
                return (
                  <g>
                    <line 
                      x1={dragStartPos.x} 
                      y1={dragStartPos.y} 
                      x2={dragCurrentPos.x} 
                      y2={dragCurrentPos.y} 
                      stroke={MATERIAL_PROPS[tool].color} 
                      strokeWidth={MATERIAL_PROPS[tool].thickness}
                      strokeDasharray="4 4"
                      className="opacity-50 pointer-events-none"
                    />
                    <rect x={midX - 25} y={midY - 10} width="50" height="20" fill="var(--color-bg)" rx="4" className="opacity-80 pointer-events-none" />
                    <text x={midX} y={midY + 4} fill="var(--color-accent)" fontSize="12" textAnchor="middle" fontWeight="bold" className="pointer-events-none">
                      {cmLength} cm
                    </text>
                  </g>
                );
              })()}

              {/* Load Bag Rendering */}
              {isTesting && loadNodeIdRef.current && (() => {
                  const node = nodes.find(n => n.id === loadNodeIdRef.current);
                  if (node) {
                     return (
                        <g transform={`translate(${node.x}, ${node.y})`}>
                          <line x1="0" y1="0" x2="0" y2="50" stroke="var(--color-text-muted)" strokeWidth="2" strokeDasharray="4 2" />
                          <rect x="-30" y="50" width="60" height="30" fill="var(--color-panel)" stroke="var(--color-accent)" strokeWidth="1" rx="4" />
                          <text x="0" y="70" fill="var(--color-accent)" fontSize="12" fontWeight="bold" textAnchor="middle">
                            {(testStats.currentLoad / 1000).toFixed(2)} kg
                          </text>
                        </g>
                     )
                  }
              })()}

              {/* Nodes */}
              {nodes.map(n => (
                <circle 
                  key={n.id} 
                  cx={n.x} 
                  cy={n.y} 
                  r={n.isAnchor ? 8 : 6} 
                  fill={n.isAnchor ? "white" : "var(--color-accent)"} 
                  className={cn(n.isAnchor ? "drop-shadow-[0_0_4px_rgba(255,255,255,0.8)]" : "cursor-move drop-shadow-[0_0_2px_rgba(0,209,255,0.8)]", tool==='delete' ? "hover:fill-[var(--color-danger)] cursor-pointer" : "")}
                />
              ))}

              {/* Hover Indicator */}
              {!isTesting && hoverPos && (tool === 'node' || tool === 'wood') && (
                <circle cx={hoverPos.x} cy={hoverPos.y} r={6} fill="none" stroke="var(--color-accent)" strokeWidth="2" className="animate-pulse pointer-events-none"/>
              )}
            </svg>
          </div>

          {/* Sidebar */}
          <div className="w-80 flex flex-col gap-4">
            
            <Card className="bg-panel border-white/5 text-text-primary rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-[14px] font-semibold text-text-muted flex items-center gap-2">幾何約束狀態</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="bg-black/30 p-3 rounded-lg border-l-4 border-l-success flex items-center justify-between text-sm">
                  <span className="text-text-muted">河流跨距 (40cm)</span>
                  {(() => {
                    const { isConnected } = validateStructure();
                    return <span className={cn("font-medium", isConnected ? "text-success" : "text-danger")}>
                      {isConnected ? '● 橋樑支撐點已連接' : '○ 支撐點未完整跨越'}
                    </span>
                  })()}
                </div>
                <div className="bg-black/30 p-3 rounded-lg border-l-4 border-l-accent flex items-center justify-between text-sm">
                  <span className="text-text-muted">最低高度 (6cm)</span>
                  {(() => {
                    const { heightPassed } = validateStructure();
                    return <span className={cn("font-medium", heightPassed ? "text-success" : "text-danger")}>
                      {heightPassed ? '● 高度達標' : '○ 桁架未達 6cm'}
                    </span>
                  })()}
                </div>
                <div className="bg-black/30 p-3 rounded-lg border-l-4 border-l-text-muted flex items-center justify-between text-sm">
                  <span className="text-text-muted">結構重量估計</span>
                  <span className="font-mono font-bold text-accent">
                    {calculateBridgeWeight(nodes, members)} g
                  </span>
                </div>
              </CardContent>
            </Card>

            {validationMsg && !isTesting && (
              <Alert className="bg-danger/10 border-danger/20 text-danger rounded-xl">
                <ShieldAlert className="h-4 w-4 stroke-danger" />
                <AlertTitle>檢測失敗</AlertTitle>
                <AlertDescription className="text-xs mt-1 leading-relaxed text-danger/90">
                  {validationMsg}
                </AlertDescription>
              </Alert>
            )}

            {isTesting && testResult && (
              <Card className={cn(
                "border-2 bg-panel rounded-xl",
                testResult.status === 'success' ? "border-success/30" : 
                testResult.status === 'failed' ? "border-danger/30" : "border-accent/30"
              )}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold flex items-center gap-2 text-text-primary">
                    <Activity className={cn(
                      "w-4 h-4",
                      testResult.status === 'success' ? "text-success" : 
                      testResult.status === 'failed' ? "text-danger" : "text-accent"
                    )}/> 
                    [診斷終端] {testResult.status === 'running' ? '分析中...' : 
                     testResult.status === 'success' ? '測試通過' : '結構失效'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between bg-black/20 p-2 rounded text-sm text-text-primary">
                     <span className="text-text-muted">橋樑自重:</span>
                     <span className="font-mono text-text-primary">{testStats.bridgeWeight.toFixed(1)} g</span>
                  </div>
                  <div className="flex justify-between bg-black/20 p-2 rounded text-sm text-text-primary">
                     <span className="text-text-muted">懸掛載重:</span>
                     <span className={cn("font-mono font-bold", testStats.broken ? "text-danger" : "text-accent")}>
                        {(testStats.currentLoad / 1000).toFixed(2)} kg
                     </span>
                  </div>
                  {testStats.broken && (
                    <div className="flex justify-between bg-black/20 p-2 rounded text-sm text-text-primary border border-white/5 shadow-inner">
                       <span className="text-text-muted">載重比 (Load/Weight):</span>
                       <span className="font-mono text-success font-bold text-base">
                          {testStats.bridgeWeight > 0 ? (testStats.currentLoad / testStats.bridgeWeight).toFixed(1) : '-'} 倍
                       </span>
                    </div>
                  )}
                  <div className="bg-black/30 rounded p-3 mt-3 font-mono text-[13px] border border-white/5">
                    {testResult.message ? (
                      <span className={testResult.status === 'success' ? "text-success" : "text-danger"}>
                        {">"} {testResult.message}
                      </span>
                    ) : (
                      <span className="text-success opacity-80 animate-pulse">
                        {">"} 系統就緒。應力分佈演算中...
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="flex-1 bg-panel border-white/5 text-text-primary rounded-xl">
              <CardHeader className="pb-2">
                <CardTitle className="text-[14px] font-semibold text-text-muted flex items-center gap-2">材料屬性</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="bg-black/30 p-3 rounded-lg border-l-4 border-l-[var(--color-wood)] flex items-center justify-between">
                  <span className="font-semibold text-sm">木材 (Wood)</span>
                  <span className="text-[11px] text-text-muted font-mono">高強度 / 高重</span>
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </div>
    </div>
  );
}

