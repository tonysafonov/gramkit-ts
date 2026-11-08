import { z } from 'zod';
import { type GroupSchema, toGroupResponse, toUserResponse, type UserSchema } from '../users/schemas';

export const StartMode = { DRAW: 'draw' } as const;
export type StartMode = (typeof StartMode)[keyof typeof StartMode];

/** Body of `POST /process_start`. */
export const StartParamsBody = z.object({
  invite_code: z.string().nullish(),
  referal_id: z.string().nullish(),
  mode: z.enum([StartMode.DRAW]).nullish(),
  page: z.string().nullish(),
  timezone: z.string().nullish(),
});

/** `StartParamsRequest` as the service takes it (camelCase, `undefined` for what wasn't sent). */
export interface StartParams {
  inviteCode?: string | null;
  referalId?: string | null;
  mode?: StartMode | null;
  page?: string | null;
  timezone?: string | null;
}

export const toStartParams = (body: z.infer<typeof StartParamsBody>): StartParams => ({
  inviteCode: body.invite_code,
  referalId: body.referal_id,
  mode: body.mode,
  page: body.page,
  timezone: body.timezone,
});

export interface StartData {
  currentUser: UserSchema;
  inviter: GroupSchema | null;
  mode: StartMode | null;
}

export const toStartDataResponse = (data: StartData) => ({
  current_user: toUserResponse(data.currentUser),
  inviter: data.inviter ? toGroupResponse(data.inviter) : null,
  mode: data.mode,
});
