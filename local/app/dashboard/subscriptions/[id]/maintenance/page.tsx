import { SubscriptionMaintenance } from "@local/components/subscription-maintenance";

export default async function MaintenancePage({ params }: { params: Promise<{ id: string }> }) {
  return <SubscriptionMaintenance subscriptionId={(await params).id} />;
}
