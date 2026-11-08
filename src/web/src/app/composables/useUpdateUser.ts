import { computed, type ComputedRef } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import { toast } from 'vue-sonner';
import { currentUserKey, useUpdateCurrentUser, type UserSchema } from '@/api';

/**
 * Composable for updating current user with optimistic updates.
 *
 * Features:
 * - Optimistic UI updates (instant feedback)
 * - Automatic rollback on error
 * - Toast notifications
 * - Query cache synchronization
 *
 * @example
 * const { mutateAsync: updateUser } = useUpdateUser();
 * await updateUser({ app_language_code: 'ru' });
 */
export function useUpdateUser(): {
  mutate: (data: Partial<UserSchema>) => void;
  mutateAsync: (data: Partial<UserSchema>) => Promise<void>;
  isPending: ComputedRef<boolean>;
} {
  const queryClient = useQueryClient();

  const updateMutation = useUpdateCurrentUser({
    mutation: {
      // Phase 1: Before server responds (optimistic update)
      onMutate: async (variables) => {
        // Cancel any outgoing queries to avoid race conditions
        await queryClient.cancelQueries({
          queryKey: currentUserKey(),
        });

        // Snapshot the previous value for rollback
        const previousUser = queryClient.getQueryData<UserSchema>(
          currentUserKey()
        );

        // Optimistically update the cache
        if (previousUser && variables.data) {
          queryClient.setQueryData<UserSchema>(currentUserKey(), {
            ...previousUser,
            ...variables.data,
          });
        }

        // Return context with snapshot for potential rollback
        return { previousUser };
      },

      // Phase 2: If server request fails (rollback)
      onError: (error, variables, context) => {
        // Restore the previous state
        if (context?.previousUser) {
          queryClient.setQueryData(currentUserKey(), context.previousUser);
        }

        // Show error notification
        toast.error('Failed to update profile');
        console.error('Error updating user:', error);
      },

      // Phase 3: Server request succeeded (sync)
      onSuccess: () => {
        // Invalidate to ensure we're in sync with server
        void queryClient.invalidateQueries({
          queryKey: currentUserKey(),
        });

        // Show success notification
        toast.success('Profile updated successfully');
      },
    },
  });

  return {
    mutate: (data: Partial<UserSchema>) => updateMutation.mutate({ data }),
    mutateAsync: async (data: Partial<UserSchema>) => {
      await updateMutation.mutateAsync({ data });
    },
    isPending: computed(() => updateMutation.isPending.value),
  };
}
