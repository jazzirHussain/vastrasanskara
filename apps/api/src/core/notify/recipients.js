import { getCustomerForNotification } from '../../modules/customers/service.js';
import { User } from '../../modules/users/model.js';

/**
 * Recipient = { kind: 'user'|'client', id, name, addresses: { email?, phone?, in_app? },
 * consent?: { [channel]: boolean } }. Staff (kind 'user') have consent implied.
 */
const resolvers = new Map();

export function registerRecipientResolver(role, resolve) {
  resolvers.set(role, resolve);
}

export async function resolveRecipients(role, args) {
  const resolve = resolvers.get(role);
  if (!resolve) throw new Error(`No recipient resolver for role: ${role}`);
  return (await resolve(args)) ?? [];
}

export function userRecipient(user) {
  const id = String(user._id);
  return { kind: 'user', id, name: user.name, addresses: { email: user.email, in_app: id } };
}

async function activeUsersWithRole(branchId, role, session) {
  const users = await User.find({ branchId, active: true, roles: role }).session(session ?? null).lean();
  return users.map(userRecipient);
}

registerRecipientResolver('owner', ({ branchId, session }) => activeUsersWithRole(branchId, 'admin', session));
registerRecipientResolver('operations', ({ branchId, session }) =>
  activeUsersWithRole(branchId, 'operations', session),
);
registerRecipientResolver('user', async ({ data, session }) => {
  if (!data?.userId) return [];
  const user = await User.findById(data.userId).session(session ?? null).lean();
  return user ? [userRecipient(user)] : [];
});
registerRecipientResolver('client', async ({ data, session }) => {
  const recipient = data?.customerId ? await getCustomerForNotification(data.customerId, session) : null;
  return recipient ? [recipient] : [];
});
