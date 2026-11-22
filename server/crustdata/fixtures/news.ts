import seller from '../../../config/seller.json' with { type: 'json' };

// Synthetic HTML stays behind the fixture transport and is always parsed with mode: fixture.
const articles = seller.displacementEvents.map(event => ({
  url: event.sourceUrl,
  title: `${event.provider}: ${event.product} ${event.kind.replaceAll('_', ' ')}`,
  date: event.date,
}));

export const acquihireFixtureArticle = {
  url: 'https://thenextweb.com/news/nvidia-poolside-6bn-model-factory-licence',
  title: 'Nvidia pays Poolside $6bn to license its model factory and hire 109 staff',
  date: '2026-08-21',
};

export function acquihireSearchFixture(request: { query?: string; sources?: string[] }) {
  const found = /poolside/i.test(request.query ?? '') && /nvidia/i.test(request.query ?? '');
  return { success: true, query: request.query ?? '', timestamp: Date.parse('2026-11-22T12:00:00Z'),
    results: found ? [{ source: request.sources?.[0] ?? 'news', title: acquihireFixtureArticle.title, url: acquihireFixtureArticle.url,
      snippet: 'Synthetic fixture of the model licence and staff transfer report.', position: 1 }] : [],
    metadata: { total_results: found ? 1 : 0, failed_pages: [], empty_pages: [] } };
}

export function newsSearchFixture(request: { query?: string; start_date?: number; end_date?: number }) {
  return {
    success: true, query: request.query ?? '', timestamp: Date.parse('2026-11-22T12:00:00Z'),
    results: articles.filter(article => request.query?.includes(article.title.split(':')[0]) &&
      Date.parse(article.date) / 1000 > (request.start_date ?? 0) &&
      Date.parse(article.date) / 1000 <= (request.end_date ?? Infinity))
      .map((article, index) => ({ source: 'news', title: article.title, url: article.url,
        snippet: 'Synthetic news article for the offline demonstration.', position: index + 1 })),
    metadata: { total_results: articles.length, failed_pages: [], empty_pages: [] },
  };
}

export function newsFetchFixture(request: { urls?: string[] }) {
  return (request.urls ?? []).map(url => {
    const article = [...articles, acquihireFixtureArticle].find(article => article.url === url);
    return { success: true, url, timestamp: 1795348800, title: article?.title ?? 'Publisher homepage',
      content: article ? `<html><head><title>${article.title}</title><meta property="article:published_time" content="${article.date}T09:00:00Z"></head><body>${article.title}</body></html>`
        : '<html><head><title>Publisher homepage</title></head><body>No publication metadata.</body></html>' };
  });
}
