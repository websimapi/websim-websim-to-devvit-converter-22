export const getMainTs = (title) => {
    const safeTitle = title.replace(/'/g, "\\'");
    return `
import { Devvit } from '@devvit/public-api';

// 1. Configure Devvit
Devvit.configure({
  redditAPI: true,
  redis: true,
});

// 2. Database & Bridge Helper
const DB_REGISTRY_KEY = 'sys:registry';

async function handleWebviewMessage(msg: any, context: any) {
    const { redis, ui } = context;
    // msg structure: { type, collection, key, value }
    
    try {
        if (msg.type === 'save') {
            const { collection, key, value } = msg;
            await redis.hSet(collection, { [key]: JSON.stringify(value) });
            await redis.zAdd(DB_REGISTRY_KEY, { member: collection, score: Date.now() });
        } else if (msg.type === 'load') {
            const { collection, key } = msg;
            const value = await redis.hGet(collection, key);
            context.ui.webView.postMessage('game-view', {
                type: 'load_response',
                collection,
                key,
                value: value ? JSON.parse(value) : null
            });
        } else if (msg.type === 'init') {
            // Fetch all data
            const collections = await redis.zRange(DB_REGISTRY_KEY, 0, -1);
            const dbData: any = {};
            await Promise.all(collections.map(async (item: any) => {
                const colName = typeof item === 'string' ? item : item.member;
                const raw = await redis.hGetAll(colName);
                const parsed: any = {};
                for (const [k, v] of Object.entries(raw)) {
                     try { parsed[k] = JSON.parse(v as string); } catch(e) { parsed[k] = v; }
                }
                dbData[colName] = parsed;
            }));
            
            // Get User
            let user = null;
            try {
                const currUser = await context.reddit.getCurrentUser();
                if (currUser) {
                    user = {
                        id: currUser.id,
                        username: currUser.username,
                        avatar_url: currUser.snoovatarImage || 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                    };
                }
            } catch(e) {}
            
            context.ui.webView.postMessage('game-view', {
                type: 'init_response',
                dbData,
                user
            });
        }
    } catch(e) {
        console.error('Bridge Error', e);
    }
}

// 3. Custom Post Type (The Game)
Devvit.addCustomPostType({
  name: 'WebSimGame',
  height: 'tall',
  render: (context) => {
    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="game-view"
          url="index.html"
          height="100%"
          width="100%"
          onMessage={(msg) => handleWebviewMessage(msg, context)}
        />
      </vstack>
    );
  },
});

// 4. Menu Item (Create Post)
Devvit.addMenuItem({
  label: 'Add Game Post',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    const subreddit = await reddit.getCurrentSubreddit();
    
    try {
        await reddit.submitPost({
            title: '${safeTitle}',
            subredditName: subreddit.name,
            preview: (
                <vstack height="100%" width="100%" alignment="middle center">
                    <text size="large">Loading Game...</text>
                </vstack>
            ),
        });
        ui.showToast({ text: 'Game post created!' });
    } catch(e) {
        console.error(e);
        ui.showToast({ text: 'Failed to create post' });
    }
  },
});

// 5. Install Trigger
Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (event, context) => {
    console.log('App installed successfully!');
    context.ui.showToast({ text: 'Game installed! Use the menu to add a game post.' });
  },
});

export default Devvit;
`;
};

