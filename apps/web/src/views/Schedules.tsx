import type { ReactNode } from "react"
import { IconCalendar, IconCheck, IconClock, IconRefresh, IconTrash } from "../components/icons.js"

export function SchedulesView(): ReactNode {
	return (
		<div className="p-4 space-y-4">
			<h2 className="text-xl font-bold mb-4">Zeitplan</h2>
			<div className="space-y-4">
				<!-- Empty state -->
				<div className="p-4 border rounded" style={{borderColor: "#3f3f46"}}>
					<p className="text-sm text-muted-foreground">
						Keine geplanten Tasks.
						
						<button className="mt-2 btn-primary" onClick={() => window.location.href = "/schedules/new"}>
							Neuen Schedule erstellen
						</button>
					</p>
				</div>
				<!-- Schedules list would go here -->
			</div>
		</div>
	)
}
