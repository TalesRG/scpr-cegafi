import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';

const DEFAULT_CATEGORY_URL = 'https://www.edocampo.com.br/queijos';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PAGES = 100;
const PRODUCT_LINK_SELECTOR = 'a[href*="/p?skuId="]:has(h3)';

interface RawEdoCampoProduct {
  id: string | null;
  skuId: string | null;
  name: string | null;
  brand: string | null;
  priceText: string | null;
  listPriceText: string | null;
  seller: string | null;
  imageUrl: string | null;
  url: string;
  available: boolean;
}

export interface EdoCampoProduct {
  id: string | null;
  skuId: string;
  name: string;
  brand: string | null;
  price: number | null;
  listPrice: number | null;
  seller: string | null;
  imageUrl: string | null;
  url: string;
  available: boolean;
}

export interface EdoCampoScrapeResult {
  source: string;
  scrapedAt: string;
  total: number;
  products: EdoCampoProduct[];
}

export function parseBrazilianCurrency(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/[^\d,.-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.');
  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

@Injectable()
export class ScraperService {
  private activeScrape: Promise<EdoCampoScrapeResult> | null = null;

  async scraperEdoCampo(): Promise<EdoCampoScrapeResult> {
    const scrape = this.activeScrape ?? this.executeScrape();
    this.activeScrape = scrape;

    try {
      return await scrape;
    } finally {
      if (this.activeScrape === scrape) {
        this.activeScrape = null;
      }
    }
  }

  private async executeScrape(): Promise<EdoCampoScrapeResult> {
    const source = process.env.EDOCAMPO_CATEGORY_URL ?? DEFAULT_CATEGORY_URL;
    const timeout = this.getTimeout();
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch(this.getLaunchOptions());
      const context = await browser.newContext({
        locale: 'pt-BR',
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(timeout);
      page.setDefaultNavigationTimeout(timeout);

      await page.goto(source, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      await page.locator(PRODUCT_LINK_SELECTOR).first().waitFor({
        state: 'visible',
        timeout,
      });

      await this.loadAllPages(page, timeout);
      const products = await this.extractProducts(page);

      if (products.length === 0) {
        throw new Error('Nenhum produto foi encontrado na página.');
      }

      return {
        source,
        scrapedAt: new Date().toISOString(),
        total: products.length,
        products,
      };
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'Erro desconhecido no scraper.';

      throw new ServiceUnavailableException({
        message: 'Não foi possível coletar o catálogo do Edocampo.',
        detail,
      });
    } finally {
      await browser?.close();
    }
  }

  private async loadAllPages(page: Page, timeout: number): Promise<void> {
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
      const loadMoreButton = page
        .getByRole('button', { name: /carregar mais produtos/i })
        .first();
      const isVisible = await loadMoreButton.isVisible().catch(() => false);

      if (!isVisible) {
        return;
      }

      const currentProductCount = await page
        .locator(PRODUCT_LINK_SELECTOR)
        .count();

      await loadMoreButton.scrollIntoViewIfNeeded();
      await Promise.all([
        page.waitForFunction(
          ({ selector, previousCount }) =>
            document.querySelectorAll(selector).length > previousCount,
          {
            selector: PRODUCT_LINK_SELECTOR,
            previousCount: currentProductCount,
          },
          { timeout },
        ),
        loadMoreButton.click(),
      ]);
    }

    throw new Error(
      `O limite de segurança de ${MAX_PAGES} páginas foi atingido.`,
    );
  }

  private async extractProducts(page: Page): Promise<EdoCampoProduct[]> {
    const rawProducts: RawEdoCampoProduct[] = await page
      .locator(PRODUCT_LINK_SELECTOR)
      .evaluateAll((anchors) => {
        const normalizeText = (value: string | null | undefined) => {
          const normalized = value?.replace(/\s+/g, ' ').trim();
          return normalized || null;
        };

        return anchors.map((element) => {
          const anchor = element as HTMLAnchorElement;
          const card = anchor.parentElement ?? anchor;
          const url = new URL(anchor.href, window.location.origin);
          const productId = url.pathname.match(/-(\d+)\/p\/?$/)?.[1] ?? null;
          const priceElements = Array.from(card.querySelectorAll('span'));
          const priceElement = priceElements.find((candidate) =>
            /^R\$\s*[\d.]+,\d{2}$/.test(
              normalizeText(candidate.textContent) ?? '',
            ),
          );
          const listPriceElement = Array.from(
            card.querySelectorAll('s, del, [class*="line-through"]'),
          ).find((candidate) =>
            (normalizeText(candidate.textContent) ?? '').includes('R$'),
          );
          const sellerElement = Array.from(card.querySelectorAll('p')).find(
            (candidate) =>
              (normalizeText(candidate.textContent) ?? '').startsWith(
                'Vendido por',
              ),
          );
          const seller =
            normalizeText(sellerElement?.querySelector('span')?.textContent) ??
            (normalizeText(sellerElement?.textContent)?.replace(
              /^Vendido por\s*/i,
              '',
            ) ||
              null);
          const image = card.querySelector('img');
          const addToCartButton = card.querySelector<HTMLButtonElement>(
            'button[aria-label="Adicionar ao carrinho"]',
          );

          return {
            id: productId,
            skuId: url.searchParams.get('skuId'),
            name: normalizeText(card.querySelector('h3')?.textContent),
            brand: normalizeText(
              card.querySelector('a[href*="/marca/"]')?.textContent,
            ),
            priceText: normalizeText(priceElement?.textContent),
            listPriceText: normalizeText(listPriceElement?.textContent),
            seller,
            imageUrl: image?.getAttribute('src') || image?.currentSrc || null,
            url: url.toString(),
            available: Boolean(addToCartButton && !addToCartButton.disabled),
          };
        });
      });

    const productsBySku = new Map<string, EdoCampoProduct>();

    for (const product of rawProducts) {
      if (!product.skuId || !product.name) {
        continue;
      }

      productsBySku.set(product.skuId, {
        id: product.id,
        skuId: product.skuId,
        name: product.name,
        brand: product.brand,
        price: parseBrazilianCurrency(product.priceText),
        listPrice: parseBrazilianCurrency(product.listPriceText),
        seller: product.seller,
        imageUrl: product.imageUrl,
        url: product.url,
        available: product.available,
      });
    }

    return Array.from(productsBySku.values());
  }

  private getLaunchOptions(): Parameters<typeof chromium.launch>[0] {
    const options: Parameters<typeof chromium.launch>[0] = {
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    };
    const configuredExecutable = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();

    if (configuredExecutable) {
      options.executablePath = configuredExecutable;
    } else if (existsSync('/usr/bin/google-chrome')) {
      options.executablePath = '/usr/bin/google-chrome';
    }

    return options;
  }

  private getTimeout(): number {
    const configuredTimeout = Number.parseInt(
      process.env.SCRAPER_TIMEOUT_MS ?? '',
      10,
    );

    return Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS;
  }
}
