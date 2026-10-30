import { maintenanceGetResponse, maintenancePostResponse } from "@local/lib/maintenance-route-handler";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  return maintenanceGetResponse(request, (await params).id);
}
export async function POST(request: Request, { params }: Context) {
  return maintenancePostResponse(request, (await params).id);
}
