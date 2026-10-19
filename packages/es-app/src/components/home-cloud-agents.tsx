import HomeCloudAgents from "../home-cloud-agents"

// Compatibility entrypoint; Home and sidebar share DashboardProvider.cloud.
export default function CloudAgents(props: { editspace?: string }) {
  return <HomeCloudAgents project={props.editspace} onCount={() => undefined} onActivity={() => undefined} />
}
