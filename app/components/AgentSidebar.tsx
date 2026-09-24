// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Loader } from "@cloudflare/kumo";
import { PlugsIcon, RobotIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import MCPPanel from "./MCPPanel";

function LazyAgentPanel() {
	const [AgentChat, setAgentChat] = useState<React.ComponentType | null>(
		null,
	);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		import("~/components/AgentPanel").then((mod) => {
			setAgentChat(() => mod.default);
		}).catch((err) => {
			console.error("Failed to load AgentPanel:", err);
			setLoadError("Failed to load agent panel");
		});
	}, []);

	if (loadError) {
		return (
			<div className="flex items-center justify-center h-full">
				<span className="text-xs text-kumo-error">{loadError}</span>
			</div>
		);
	}
	if (!AgentChat) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2">
				<Loader size="base" />
				<span className="text-xs text-kumo-subtle">Loading agent...</span>
			</div>
		);
	}
	return <AgentChat />;
}

export default function AgentSidebar() {
	const [activeTab, setActiveTab] = useState<"agent" | "mcp">("agent");
	const [budget, setBudget] = useState<{limit:number; reserved:number; day:string; starts:string} | null>(null);
	useEffect(() => {
		let alive = true;
		const refresh = () => fetch('/api/v1/ai-budget', {cache:'no-store'})
			.then(r => { if (!r.ok) throw new Error('budget unavailable'); return r.json() as Promise<{limit:number; reserved:number; day:string; starts:string}>; })
			.then(value => { if (alive) setBudget(value); })
			.catch(() => { if (alive) setBudget(null); });
		void refresh();
		const interval = setInterval(refresh, 60000);
		return () => { alive = false; clearInterval(interval); };
	}, []);

	return (
		<div className="flex flex-col h-full">
			{/* Tab bar */}
			<div className="flex items-center border-b border-kumo-line shrink-0">
				<button
					type="button"
					onClick={() => setActiveTab("agent")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "agent"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<RobotIcon size={14} weight={activeTab === "agent" ? "fill" : "regular"} />
					Agent
				</button>
				<button
					type="button"
					onClick={() => setActiveTab("mcp")}
					className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 bg-transparent cursor-pointer ${
						activeTab === "mcp"
							? "border-kumo-brand text-kumo-default"
							: "border-transparent text-kumo-subtle hover:text-kumo-default"
					}`}
				>
					<PlugsIcon size={14} weight={activeTab === "mcp" ? "fill" : "regular"} />
					MCP
				</button>
			</div>

			<div className="px-3 py-2 text-xs text-kumo-subtle border-b border-kumo-line" role="status">
				{budget ? budget.day < budget.starts
					? 'AI safeguard active. AI starts at the next 5:00 AM Pakistan reset. Regular email works.'
					: `AI budget: ${budget.reserved.toLocaleString()} / ${budget.limit.toLocaleString()} reserved units today. Shared by all mailboxes; resets at 5:00 AM Pakistan. Large requests may pause earlier.`
					: 'AI budget status unavailable. AI requests require a successful budget check.'}
			</div>
			{/* Tab content — keep agent mounted so chat isn't lost */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div className={activeTab === "agent" ? "h-full" : "hidden"}>
					<LazyAgentPanel />
				</div>
				{activeTab === "mcp" && <MCPPanel />}
			</div>
		</div>
	);
}
