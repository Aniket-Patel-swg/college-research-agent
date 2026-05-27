/**
 * Shape returned by the /college-details endpoint. Mirrors the layout the
 * frontend college detail page renders. Every field is optional so the page
 * can gracefully degrade when the web research can't find a value.
 */
export type CollegeDetails = {
  /** Original college name the user requested (echoed verbatim). */
  query: string;

  /** Best-effort canonical name the agent confirmed (e.g. "DA-IICT Gandhinagar"). */
  collegeName: string;

  /** Short tagline (e.g. "Private University", "Government Institute"). */
  institutionType?: string;

  /** "Gandhinagar, Gujarat" */
  location?: string;

  /** Year the institute was established. */
  establishedYear?: number;

  /** Official website URL. */
  websiteUrl?: string;

  /** Logo URL (if reliably discoverable). */
  logoUrl?: string;

  /** Header subtitle: e.g. "Established 2001". */
  about?: string;

  quickStats: {
    campusSize?: string;
    avgPackage?: string;
    highestPackage?: string;
    totalFaculty?: string;
    studentStrength?: string;
    nirfRank?: string;
  };

  topRecruiters: string[];

  cutoffTrends: {
    branch: string;
    /** Display label e.g. "Rank: 42 - 156". */
    rankRange?: string;
    closingRankLow?: number;
    closingRankHigh?: number;
    notes?: string;
  }[];

  competitionLevel?:
    | "Extremely High"
    | "High"
    | "Moderate"
    | "Low";

  admissionType?: string;

  campusInfrastructure: {
    name: string;
    description?: string;
    imageUrl?: string;
  }[];

  applicationDeadline?: string;
  yearlyFee?: string;

  contact: {
    admissionsPhone?: string;
    admissionsEmail?: string;
    address?: string;
  };

  highlights?: string[];

  /** Sources the agent cited while researching. */
  sources: { title?: string; url: string }[];

  /** ISO timestamp when this payload was generated (or pulled from cache). */
  generatedAt: string;

  /** True when served from the DynamoDB cache. */
  fromCache: boolean;
};
