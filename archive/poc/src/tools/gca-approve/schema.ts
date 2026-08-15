/**
 * gca_approve Tool Schema — approve or reject pending gca-server operations.
 */

export const gcaApproveInputSchema = {
  type: 'object' as const,
  properties: {
    code: {
      type: 'string',
      description: 'The 6-digit confirmation code from the push notification',
    },
    action: {
      type: 'string',
      enum: ['approve', 'reject'],
      description: 'Whether to approve or reject the pending operation. Default: approve',
    },
  },
  required: ['code'],
};
