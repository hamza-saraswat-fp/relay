import { type NextRequest, NextResponse } from "next/server";

/**
 * Salesforce case-create → link endpoint (scaffold — real logic lands with IAI-237).
 *
 * The onboarding-app pattern: a Salesforce automation fires when a case is created and
 * POSTs the account id here, authenticated by a static bearer key. This endpoint will
 * upsert the account, mint (or return the existing) permanent token, and return the
 * tracker URL; the SF automation writes that URL to `Relay_Tracker_Link__c`.
 *
 * Auth mirrors onboarding-api's generate-link route:
 *   Authorization: Bearer ${SALESFORCE_INTEGRATION_KEY}
 */
export async function POST(req: NextRequest) {
  const key = process.env.SALESFORCE_INTEGRATION_KEY;
  if (!key || req.headers.get("authorization") !== `Bearer ${key}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(
    { error: "case-created endpoint not implemented yet — see IAI-237" },
    { status: 501 }
  );
}
