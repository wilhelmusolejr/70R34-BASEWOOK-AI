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
    description: 'Fill in Facebook profile About section (bio, work, education, places, relationship). Self-navigates via /me — no profileUrl needed. On completion, PATCHes the user record with status="Active" and profileSetup=true.',
    params: {
      bio: { type: 'string', description: 'Profile bio / intro text' },
      city: { type: 'string', description: 'Current city' },
      hometown: { type: 'string', description: 'Hometown' },
      userId: { type: 'string', default: '', description: 'User ID for the PATCH call that sets status=Active + profileSetup=true. Auto-injected from user._id when omitted.' },
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
    description: 'Upload a profile picture from a URL. Probes the current page for the "Profile picture actions" trigger; navigates to /me only on miss. Caption priority: explicit description → AI-generated from userIdentity → random Bible verse fallback.',
    params: {
      photoUrl: { type: 'string', description: 'Public URL of the image to upload as profile picture' },
      description: { type: 'string', default: '', description: 'Explicit caption — overrides AI generation when provided.' },
      userIdentity: { type: 'string', default: '', description: 'Persona POV for AI caption. Auto-injected from user.identityPrompt when omitted.' }
    },
    hasChildren: false
  },
  create_page: {
    description: 'Navigator: create a Facebook Page, fill all form fields, upload profile + cover, and advance through Steps 2-5. Ends on the new Page URL so child steps (schedule_posts, switch_profile) can run on it.',
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
      userId: { type: 'string', default: '', description: 'User ID for the PATCH call that records the new page URL. Auto-injected from user._id when omitted.' }
    },
    hasChildren: true
  },
  schedule_posts: {
    description: 'Schedule posts on the currently loaded Facebook Page — one post per day starting tomorrow. Individual post failures are logged, not rethrown.',
    params: {
      posts: {
        type: 'array',
        description: 'Posts to schedule. Auto-injected from user.linkedPage.posts when omitted.',
        items: {
          type: 'object',
          properties: {
            post: { type: 'string', description: 'Post text content' }
          }
        }
      }
    },
    hasChildren: false
  },
  switch_profile: {
    description: 'Switch back to the personal user profile from a Page. Falls back to "Quick switch profiles" when the named button is missing.',
    params: {
      userName: { type: 'string', default: '', description: 'Full name on the personal profile. Auto-injected from user firstName + lastName when omitted.' }
    },
    hasChildren: false
  },
  search: {
    description: 'Navigator: search Facebook. Provide explicit `query`, or auto-generate — mode="name" (random first + last from 100×100 pools), mode="news" (random US state + news keyword), or mode="page" ("{category} in {city}" — city auto-injected from user.city). Optional `filter` clicks a results tab. Use child steps to act on the results.',
    params: {
      query: { type: 'string', default: '', description: 'Explicit search query. Overrides mode-based generation when provided.' },
      mode: { type: 'string', default: 'name', enum: ['name', 'news', 'page'], description: 'How to generate a query when `query` is empty' },
      filter: { type: 'string', default: '', description: 'Optional results-tab filter to click after search (e.g. "People", "Posts", "Videos", "Pages", "Groups")' },
      category: { type: 'string', default: '', description: 'Page-mode category override (e.g. "Photography"). Random from built-in pool when omitted.' },
      city: { type: 'string', default: '', description: 'Page-mode city override (e.g. "Los Angeles, California"). Auto-injected from user.city when omitted.' }
    },
    hasChildren: true
  },
  open_search_result: {
    description: 'Navigator: pick a profile/page link from the current search-results page (a[href*="/profile.php?id="]) and click into it. Use as a child of `search`; child steps then act on that profile/page.',
    params: {
      pick: { type: 'string', default: 'random', description: 'Which result to open: "random" (default), "first", or an integer index (0-based)' }
    },
    hasChildren: true
  },
  follow: {
    description: 'Leaf: click the Follow button on the currently loaded page. Selector is the same on profiles, pages, and inline search-result cards.',
    params: {},
    hasChildren: false
  },
  connect: {
    description: 'Leaf: click every "Add Friend" / "Follow" / "Like" button that is visible on the loaded profile or page, in that priority order. Add Friend matches any aria-label starting with "Add Friend" (dynamic name suffix); Follow and Like match their exact aria-label so already-followed / already-liked states do not re-click. Never throws if none are visible — logs and skips.',
    params: {},
    hasChildren: false
  },
  check_ip: {
    description: 'Fetch the browser\'s outbound IP from ipinfo.io (via the profile\'s proxy, not the host network) and POST it to the database. Runs automatically at the start of every browser session; can also be composed as a step.',
    params: {
      userId: { type: 'string', default: '', description: 'User ID to attach the IP record to. Auto-injected from user._id when omitted.' },
      endpoint: { type: 'string', default: '', description: 'Override POST endpoint. Defaults to IP_LOG_ENDPOINT env, then USER_API_BASE_URL + /api/profiles/:userId/ip-records.' }
    },
    hasChildren: false
  }
};

module.exports = actionSchemas;
