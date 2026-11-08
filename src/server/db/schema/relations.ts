import { relations } from 'drizzle-orm';
import { balances } from './balances';
import { friendships } from './friendships';
import { groupMembers, groups } from './groups';
import { groupInvites } from './invites';
import { paymentEvents, payments } from './payments';
import { subscriptions } from './subscriptions';
import { users } from './users';

export const usersRelations = relations(users, ({ one, many }) => ({
  balance: one(balances, { fields: [users.id], references: [balances.userId] }),
  payments: many(payments),
  subscriptions: many(subscriptions),
}));

export const balancesRelations = relations(balances, ({ one }) => ({
  user: one(users, { fields: [balances.userId], references: [users.id] }),
}));

export const friendshipsRelations = relations(friendships, ({ one }) => ({
  user1: one(users, { fields: [friendships.userId1], references: [users.id], relationName: 'friendship_user1' }),
  user2: one(users, { fields: [friendships.userId2], references: [users.id], relationName: 'friendship_user2' }),
}));

export const groupsRelations = relations(groups, ({ one, many }) => ({
  creator: one(users, { fields: [groups.creatorId], references: [users.id] }),
  members: many(groupMembers),
}));

export const groupMembersRelations = relations(groupMembers, ({ one }) => ({
  group: one(groups, { fields: [groupMembers.groupId], references: [groups.id] }),
  user: one(users, { fields: [groupMembers.userId], references: [users.id] }),
}));

export const groupInvitesRelations = relations(groupInvites, ({ one }) => ({
  creator: one(users, { fields: [groupInvites.creatorId], references: [users.id] }),
  group: one(groups, { fields: [groupInvites.groupId], references: [groups.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  user: one(users, { fields: [payments.userId], references: [users.id] }),
  subscription: one(subscriptions, { fields: [payments.subscriptionId], references: [subscriptions.id] }),
  events: many(paymentEvents),
}));

export const paymentEventsRelations = relations(paymentEvents, ({ one }) => ({
  payment: one(payments, { fields: [paymentEvents.paymentId], references: [payments.id] }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  payments: many(payments),
}));
