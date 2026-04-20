/**
 * Single source of truth for action parameters.
 * Each action defines its params shape and whether it can contain child steps.
 */

const actionSchemas = {
  homepage_interaction: {
    description: 'Navigate to Facebook homepage / news feed',
    params: {},
    hasChildren: true
  },
  scroll: {
    description: 'Scroll the current page for a duration with human-like behavior',
    params: {
      duration: { type: 'number', default: 10, description: 'Seconds to scroll' },
      direction: { type: 'string', default: 'down', enum: ['down', 'up'], description: 'Scroll direction' }
    },
    hasChildren: false
  },
  like_posts: {
    description: 'Like posts on the current page (scroll first to load posts)',
    params: {
      count: { type: 'number', default: 2, description: 'Number of posts to like' },
      mode: { type: 'string', default: 'fixed', enum: ['fixed', 'half'], description: 'fixed=use count, half=like ~50% of found posts' }
    },
    hasChildren: false
  },
  share_posts: {
    description: 'Share posts from the current page. Provide message for static text, or userIdentity + instruction for Claude API-generated message (fallback: empty).',
    params: {
      count: { type: 'number', default: 1, description: 'Number of posts to share' },
      message: { type: 'string', default: '', description: 'Static message to include with share (overrides API generation)' },
      userIdentity: { type: 'string', default: '', description: 'Who the account is (used for API generation)' },
      instruction: { type: 'string', default: '', description: 'Tone/style instruction for API generation' }
    },
    hasChildren: false
  },
  share_post: {
    description: 'Share a specific Facebook post by URL. Provide message for static text, or userIdentity + instruction for Claude API-generated message.',
    params: {
      url: { type: 'string', description: 'Full URL of the Facebook post to share' },
      message: { type: 'string', default: '', description: 'Static message (overrides API generation)' },
      userIdentity: { type: 'string', default: '', description: 'Who the account is (used for API generation)' },
      instruction: { type: 'string', default: '', description: 'Tone/style instruction for API generation' }
    },
    hasChildren: false
  },
  setup_about: {
    description: 'Fill in Facebook profile About section (bio, work, education, places, relationship). Self-navigates via /me — no profileUrl needed.',
    params: {
      bio: { type: 'string', description: 'Profile bio / intro text' },
      city: { type: 'string', description: 'Current city' },
      hometown: { type: 'string', description: 'Hometown' },
      personal: {
        type: 'object',
        description: 'Personal details',
        properties: {
          relationshipStatus: { type: 'string' },
          relationshipStatusSince: { type: 'string' },
          languages: { type: 'array', items: { type: 'string' } }
        }
      },
      work: {
        type: 'array',
        description: 'Work history entries',
        items: {
          type: 'object',
          properties: {
            company: { type: 'string' },
            position: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            current: { type: 'boolean' },
            city: { type: 'string' }
          }
        }
      },
      education: {
        type: 'object',
        description: 'Education history',
        properties: {
          college: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              graduated: { type: 'boolean' },
              degree: { type: 'string' }
            }
          },
          highSchool: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              from: { type: 'string' },
              to: { type: 'string' },
              graduated: { type: 'boolean' }
            }
          }
        }
      }
    },
    hasChildren: false
  },
  visit_profile: {
    description: 'Navigate to a Facebook profile by URL. Use child steps to act on the profile.',
    params: {
      url: { type: 'string', description: 'Full Facebook profile URL' }
    },
    hasChildren: true
  },
  add_friend: {
    description: 'Send a friend request on the currently loaded profile page. Use as a child step under visit_profile.',
    params: {},
    hasChildren: false
  },
  setup_cover: {
    description: 'Upload a cover photo from a URL. Self-navigates to /me — no profileUrl needed.',
    params: {
      photoUrl: { type: 'string', description: 'Public URL of the image to upload as cover photo' }
    },
    hasChildren: false
  },
  setup_avatar: {
    description: 'Upload a profile picture from a URL. Self-navigates to /me — no profileUrl needed.',
    params: {
      photoUrl: { type: 'string', description: 'Public URL of the image to upload as profile picture' },
      description: { type: 'string', default: '', description: 'Optional caption/description for the profile picture post' }
    },
    hasChildren: false
  },
  setup_page: {
    description: 'Create a Facebook page by filling the page name, category, and bio, then clicking Create Page.',
    params: {
      pageName: { type: 'string', description: 'Page name to create' },
      bio: { type: 'string', default: '', description: 'Bio/description for the page' },
      email: { type: 'string', default: '', description: 'Contact email for the page' },
      streetAddress: { type: 'string', default: '', description: 'Street-only address for the page' },
      city: { type: 'string', default: '', description: 'Full city/state string, e.g. "Dallas, Texas"' },
      state: { type: 'string', default: '', description: 'State name. Auto-derived from city when omitted.' },
      zipCode: { type: 'string', default: '', description: 'ZIP code. Uses user.zip_code if present, otherwise a local seed dataset.' },
      profilePhotoUrl: { type: 'string', default: '', description: 'Profile image URL for the page' },
      coverPhotoUrl: { type: 'string', default: '', description: 'Cover image URL for the page' },
      categoryKeyword: { type: 'string', default: '', description: 'Optional category keyword. Defaults to the first word of pageName.' },
      createUrl: { type: 'string', default: 'https://www.facebook.com/pages/create', description: 'Page creation URL to open before filling the form' }
    },
    hasChildren: false
  }
};

module.exports = actionSchemas;
