<script setup lang="ts">
import { ref, computed } from 'vue';
import { Shield, Check, X, Loader2 } from '@lucide/vue';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useRbacMe, useSetDemoRole, useDemoProtectedAction, rbacMeKey, currentUserKey } from '@/api';
import { useQueryClient } from '@tanstack/vue-query';
import { getErrorMessage } from '@core/errors';

const queryClient = useQueryClient();

const { data: rbacMe, isLoading } = useRbacMe();
const setRoleMutation = useSetDemoRole();
const protectedActionMutation = useDemoProtectedAction();

const actionResult = ref<{ success: boolean; message: string } | null>(null);

const roles = ['user', 'admin', 'owner'] as const;

const currentRole = computed(() => rbacMe.value?.role || 'user');

const roleColors = {
  user: 'secondary',
  admin: 'default',
  owner: 'destructive',
} as const;

async function setRole(role: string) {
  actionResult.value = null;
  await setRoleMutation.mutateAsync({ data: { role } });
  // Invalidate queries to refresh user data
  queryClient.invalidateQueries({ queryKey: rbacMeKey() });
  queryClient.invalidateQueries({ queryKey: currentUserKey() });
}

async function tryProtectedAction() {
  actionResult.value = null;
  try {
    const result = await protectedActionMutation.mutateAsync();
    actionResult.value = { success: true, message: result.message };
  } catch (error: unknown) {
    actionResult.value = {
      success: false,
      message: getErrorMessage(error) || 'Action failed',
    };
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <div class="flex items-center gap-2">
        <Shield class="h-5 w-5 text-primary" />
        <CardTitle>RBAC Demo</CardTitle>
      </div>
      <CardDescription>
        Test role-based access control. Switch roles and try protected actions.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <!-- Loading state -->
      <div v-if="isLoading" class="flex items-center justify-center py-4">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>

      <template v-else-if="rbacMe">
        <!-- Current Role -->
        <div>
          <div class="text-sm text-muted-foreground mb-2">Current Role</div>
          <Badge :variant="roleColors[currentRole as keyof typeof roleColors] || 'secondary'" class="text-sm">
            {{ currentRole }}
          </Badge>
        </div>

        <!-- Role Switcher -->
        <div>
          <div class="text-sm text-muted-foreground mb-2">Switch Role (Demo)</div>
          <div class="flex gap-2">
            <Button
              v-for="role in roles"
              :key="role"
              :variant="currentRole === role ? 'default' : 'outline'"
              size="sm"
              :disabled="setRoleMutation.isPending.value"
              @click="setRole(role)"
            >
              {{ role }}
            </Button>
          </div>
        </div>

        <!-- Permissions -->
        <div>
          <div class="text-sm text-muted-foreground mb-2">Your Permissions</div>
          <div class="flex flex-wrap gap-1">
            <Badge
              v-for="perm in rbacMe.permissions"
              :key="perm"
              variant="outline"
              class="text-xs"
            >
              {{ perm }}
            </Badge>
          </div>
        </div>

        <!-- Protected Action -->
        <div class="pt-2 border-t">
          <div class="text-sm text-muted-foreground mb-2">Test Protected Action</div>
          <Button
            variant="destructive"
            size="sm"
            :disabled="protectedActionMutation.isPending.value"
            @click="tryProtectedAction"
          >
            <Loader2 v-if="protectedActionMutation.isPending.value" class="h-4 w-4 animate-spin mr-2" />
            Try Owner-Only Action
          </Button>

          <!-- Result -->
          <div v-if="actionResult" class="mt-2 flex items-center gap-2 text-sm">
            <Check v-if="actionResult.success" class="h-4 w-4 text-green-500" />
            <X v-else class="h-4 w-4 text-red-500" />
            <span :class="actionResult.success ? 'text-green-600' : 'text-red-600'">
              {{ actionResult.message }}
            </span>
          </div>
        </div>
      </template>
    </CardContent>
  </Card>
</template>
