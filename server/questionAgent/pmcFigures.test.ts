import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildCredit,
  buildSearchQuery,
  captionLeaksAnswer,
  fetchArticleMeta,
  parseFigures,
  pickMediaUrl,
  searchArticles,
  thirdPartyRisk,
  vetArticleFigures,
  type FetchLike,
  type PmcArticleHit,
  type PmcArticleMeta,
} from "./pmcFigures";

const XML = `
<article><body>
<fig id="f1" position="float"><?disp-level 2?><label>Fig. 1</label><caption><p>Sacral pressure injury with <bold>exposed fascia</bold> before debridement.</p></caption>
<alternatives><graphic xmlns:xlink="http://www.w3.org/1999/xlink" content-type="image" xlink:href="case-f01.webp"><?cloudpmc-path blobs/x?></graphic>
<graphic xmlns:xlink="http://www.w3.org/1999/xlink" content-type="thumb" xlink:href="case-f01.gif"></graphic></alternatives></fig>
<fig id="f2"><label>Fig. 2</label><caption><p>Reproduced with permission from Elsevier.</p></caption><graphic xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="case-f02"/></fig>
<fig id="f3"><label>Fig. 3</label><caption><p>Stage IV pressure ulcer after flap coverage.</p></caption><graphic xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="case-f03"/></fig>
<fig id="f4"><label>Fig. 4</label><caption><p>Panel.</p></caption><attrib>Photo: Getty</attrib><graphic xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="case-f04.jpg"/></fig>
</body></article>`;

const hit: PmcArticleHit = {
  pmcid: "PMC123456",
  title: "Management of sacral pressure injuries.",
  authorString: "Smith JA, Lee K.",
  journal: "Plast Reconstr Surg Glob Open",
  year: "2024",
  doi: null,
  license: "cc by",
};

const meta: PmcArticleMeta = {
  pmcid: "PMC123456",
  versionPrefix: "PMC123456.1",
  licenseCode: "CC BY",
  retracted: false,
  mediaUrls: [
    "https://pmc-oa-opendata.s3.amazonaws.com/PMC123456.1/case-f01.webp",
    "https://pmc-oa-opendata.s3.amazonaws.com/PMC123456.1/case-f02.jpg",
    "https://pmc-oa-opendata.s3.amazonaws.com/PMC123456.1/case-f03.jpg",
    "https://pmc-oa-opendata.s3.amazonaws.com/PMC123456.1/case-f04.jpg",
  ],
};

describe("parseFigures", () => {
  it("extracts ids, labels, captions and full-size graphics only", () => {
    const figs = parseFigures(XML);
    assert.equal(figs.length, 4);
    assert.equal(figs[0].figId, "f1");
    assert.equal(figs[0].label, "Fig. 1");
    assert.equal(figs[0].caption, "Sacral pressure injury with exposed fascia before debridement.");
    assert.deepEqual(figs[0].hrefs, ["case-f01.webp"]);
    assert.deepEqual(figs[1].hrefs, ["case-f02"]);
    assert.equal(figs[3].ownPermissions, true);
    assert.equal(figs[0].ownPermissions, false);
  });
});

describe("pickMediaUrl", () => {
  it("matches exact names and extensionless hrefs", () => {
    assert.match(pickMediaUrl("case-f01.webp", meta.mediaUrls)!, /case-f01\.webp$/);
    assert.match(pickMediaUrl("case-f03", meta.mediaUrls)!, /case-f03\.jpg$/);
    assert.equal(pickMediaUrl("missing", meta.mediaUrls), null);
  });
});

describe("caption checks", () => {
  it("flags third-party material", () => {
    assert.ok(thirdPartyRisk("Reproduced with permission from Elsevier"));
    assert.ok(thirdPartyRisk("Image (c) 2019 Smith"));
    assert.equal(thirdPartyRisk("Sacral wound before debridement"), null);
  });
  it("flags captions that mention answer terms", () => {
    assert.ok(captionLeaksAnswer("Stage IV pressure ulcer", ["pressure ulcer"]));
    assert.equal(captionLeaksAnswer("Sacral wound", ["pressure ulcer"]), null);
    assert.equal(captionLeaksAnswer("Sacral wound", ["ab"]), null, "very short terms are ignored");
  });
});

describe("vetArticleFigures", () => {
  it("accepts clean figures with attribution and rejects the rest with reasons", () => {
    const { accepted, rejected } = vetArticleFigures({ hit, meta, figures: parseFigures(XML), avoidTerms: ["pressure ulcer"] });
    assert.deepEqual(accepted.map((a) => a.figId), ["f1"]);
    assert.equal(accepted[0].license, "CC BY");
    assert.equal(accepted[0].sourceUrl, "https://pmc.ncbi.nlm.nih.gov/articles/PMC123456/");
    assert.match(accepted[0].credit, /^Smith JA et al\. Management of sacral pressure injuries\. Plast Reconstr Surg Glob Open 2024 \(Fig\. 1\)$/);
    const reasons = Object.fromEntries(rejected.map((r) => [r.figId, r.reason]));
    assert.match(reasons.f2, /third-party/);
    assert.match(reasons.f3, /pressure ulcer/);
    assert.match(reasons.f4, /own permissions/);
  });
  it("rejects whole articles with NC/ND licenses or retractions", () => {
    const nc = vetArticleFigures({ hit, meta: { ...meta, licenseCode: "CC BY-NC" }, figures: parseFigures(XML), avoidTerms: [] });
    assert.equal(nc.accepted.length, 0);
    assert.match(nc.rejected[0].reason, /NonCommercial/);
    const nd = vetArticleFigures({ hit, meta: { ...meta, licenseCode: "CC BY-ND" }, figures: parseFigures(XML), avoidTerms: [] });
    assert.equal(nd.accepted.length, 0);
    const retracted = vetArticleFigures({ hit, meta: { ...meta, retracted: true }, figures: parseFigures(XML), avoidTerms: [] });
    assert.match(retracted.rejected[0].reason, /retracted/);
  });
});

describe("credit and query helpers", () => {
  it("builds a bounded credit line", () => {
    const long = buildCredit({ ...hit, title: "x".repeat(900) }, "Fig. 1");
    assert.ok(long.length <= 512);
  });
  it("restricts the Europe PMC query to open, commercial-friendly licenses", () => {
    const q = buildSearchQuery("pressure ulcer", "PUB_TYPE:\"Case Reports\"");
    assert.match(q, /OPEN_ACCESS:y/);
    assert.match(q, /LICENSE:"cc by"/);
    assert.doesNotMatch(q, /nc/i);
  });
});

describe("network helpers (stubbed fetch)", () => {
  const respond = (body: string, ok = true): ReturnType<FetchLike> =>
    Promise.resolve({ ok, status: ok ? 200 : 404, text: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });

  it("searchArticles maps Europe PMC results and skips hits without a PMCID", async () => {
    const fetchFn: FetchLike = (url) => {
      assert.match(url, /europepmc/);
      return respond(
        JSON.stringify({
          resultList: {
            result: [
              { pmcid: "PMC1", title: "A <i>title</i>", authorString: "Doe J.", journalInfo: { journal: { title: "J" } }, pubYear: 2020, license: "cc by" },
              { title: "no pmcid" },
            ],
          },
        })
      );
    };
    const hits = await searchArticles(fetchFn, "flap");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, "A title");
  });

  it("fetchArticleMeta picks the latest version and reads license_code", async () => {
    const fetchFn: FetchLike = (url) => {
      if (url.includes("list-type=2")) {
        return respond(`<ListBucketResult><CommonPrefixes><Prefix>PMC9.1/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>PMC9.2/</Prefix></CommonPrefixes></ListBucketResult>`);
      }
      assert.match(url, /PMC9\.2\/PMC9\.2\.json$/);
      return respond(
        JSON.stringify({
          license_code: "CC BY",
          is_retracted: false,
          media_urls: ["s3://pmc-oa-opendata/PMC9.2/a-f01.jpg?md5=abc"],
        })
      );
    };
    const m = await fetchArticleMeta(fetchFn, "PMC9");
    assert.equal(m?.versionPrefix, "PMC9.2");
    assert.equal(m?.licenseCode, "CC BY");
    assert.equal(m?.mediaUrls[0], "https://pmc-oa-opendata.s3.amazonaws.com/PMC9.2/a-f01.jpg?md5=abc");
    assert.equal(pickMediaUrl("a-f01", m!.mediaUrls), "https://pmc-oa-opendata.s3.amazonaws.com/PMC9.2/a-f01.jpg");
  });
});
