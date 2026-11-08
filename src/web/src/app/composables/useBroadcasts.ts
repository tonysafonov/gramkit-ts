import { useQueryClient } from '@tanstack/vue-query';
import {
  broadcastKey,
  broadcastsApi,
  json,
  listBroadcastsKey,
  useCancelBroadcast,
  useCreateBroadcast,
  useEditBroadcast,
  useSendBroadcastNow,
  type BroadcastMediaUploadResponse,
} from '@/api';

export type BroadcastMediaType = 'photo' | 'video' | 'animation' | 'document';

/**
 * useBroadcasts — the admin broadcast mutations (create / edit / cancel /
 * send-now) from the core admin API (`/admin/broadcasts`), the multipart media
 * upload, and cache invalidation for the list and a single broadcast.
 *
 * Media upload is a multipart `form` call: `hc` leaves the Content-Type to the browser, so it sets the boundary itself.
 *
 * TODO: extract to core when a third Vue app needs this.
 */
export function useBroadcasts() {
  const queryClient = useQueryClient();

  const create = useCreateBroadcast();
  const edit = useEditBroadcast();
  const cancel = useCancelBroadcast();
  const sendNow = useSendBroadcastNow();

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: listBroadcastsKey() });

  const invalidateOne = (id: number) =>
    queryClient.invalidateQueries({ queryKey: broadcastKey(id) });

  /** Upload a media file (multipart) and get back the Telegram `file_id` the backend minted for it. */
  const uploadMedia = (file: File, messageType: BroadcastMediaType): Promise<BroadcastMediaUploadResponse> =>
    json(broadcastsApi.broadcasts.media.$post({ form: { file, message_type: messageType } }));

  return {
    create,
    edit,
    cancel,
    sendNow,
    uploadMedia,
    invalidateList,
    invalidateOne,
  };
}
