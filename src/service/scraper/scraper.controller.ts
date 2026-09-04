import { Controller, Get } from '@nestjs/common';
import {
  type EdoCampoScrapeResult,
  ScraperService,
} from './scraper.service.js';

@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  @Get('edocampo')
  scraperEdoCampo(): Promise<EdoCampoScrapeResult> {
    return this.scraperService.scraperEdoCampo();
  }
}
