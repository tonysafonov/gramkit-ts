import { PaymentProvider } from '../../../db/schema';
import type { Repos } from '../../../repos';
import type { Services } from '../../../services';
import type { ProductCatalog } from '../products';
import { type PaymentProviderInterface, PaymentValueError } from '../types';
import { TelegramStarsProvider } from './telegram-stars';
import { YooKassaProvider } from './yookassa';

/** The provider implementation for an id. Config is read from settings by each provider. */
export function getProvider(
  providerId: string,
  repos: Repos,
  services: Services,
  products: ProductCatalog,
): PaymentProviderInterface {
  switch (providerId) {
    case PaymentProvider.YOOKASSA:
      return new YooKassaProvider(repos, products);
    case PaymentProvider.TELEGRAM_STARS:
      return new TelegramStarsProvider(repos, services, products);
    default:
      throw new PaymentValueError(`Provider ${providerId} not supported`);
  }
}
