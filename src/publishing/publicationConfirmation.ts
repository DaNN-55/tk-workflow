export interface PublicationConfirmationInput {
  acknowledged: boolean;
  reason: string;
}

export function createPublicationConfirmation(input: PublicationConfirmationInput): { reason: string } {
  if (!input.acknowledged) throw new Error("请确认已在目标平台手工发布。");
  const reason = input.reason.trim();
  if (!reason) throw new Error("请填写发布确认理由。");
  return { reason };
}
