import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { defineSecret } from 'firebase-functions/params';

// Define the Gemini API key secret with a different name to avoid conflicts
const geminiSecretKey = defineSecret('GEMINI_SECRET_KEY');

// Rule: Always add debug logs
console.log('🚀 Cloud Functions V2 initialized');

// Initialize Firebase Admin with application default credentials
// This is safer than using a service account key file
const app = initializeApp();
console.log('🔥 Firebase Admin initialized', { appName: app.name });

// Get Firestore instance
const db = getFirestore();
console.log('📊 Firestore initialized');

// Define conversation data interface for type safety
interface ConversationData {
  messages: Array<{
    role: string;
    content: string;
    timestamp: any;
  }>;
  lastUpdated?: any;
}

// Check if user has premium subscription
async function checkUserSubscription(uid: string): Promise<boolean> {
    try {
        // Debug log
        console.log('💲 Checking subscription status for user:', uid);
        
        // First check RevenueCat customers collection
        const revenueCatCustomerRef = db.collection('customers').doc(uid);
        let revenueCatData;
        
        try {
            revenueCatData = await revenueCatCustomerRef.get();
        } catch (error) {
            console.log('💲 Error fetching RevenueCat data:', error);
            // Continue with fallback checks
        }
        
        if (revenueCatData && revenueCatData.exists) {
            const customerData = revenueCatData.data();
            console.log('💲 RevenueCat customer data found:', customerData);
            
            // Check if customer has active premium entitlement
            if (customerData?.subscriptions && 
                customerData.subscriptions['com.hunyhun.aisaint.premium.monthly']?.entitlements?.['Monthly Premium']?.active === true) {
                console.log('💲 User has active premium subscription via RevenueCat data');
                return true;
            }
        } else {
            console.log('💲 No RevenueCat customer data found, checking user document');
        }
        
        // If no RevenueCat data or not premium, check user document as fallback
        const userDocRef = db.collection('users').doc(uid);
        let userDoc;
        
        try {
            userDoc = await userDocRef.get();
        } catch (error) {
            console.log('💲 Error fetching user document:', error);
            // Default to free tier if we can't check
            return false;
        }
        
        if (userDoc && userDoc.exists) {
            const userData = userDoc.data();
            console.log('💲 User document data:', userData);
            
            // Check for premium status flag in user data
            if (userData?.isPremium === true || userData?.subscriptionTier === 'premium') {
                console.log('💲 User has premium status via user document');
                return true;
            }
        } else {
            console.log('💲 No user document found');
        }
        
        console.log('💲 User does not have premium subscription');
        return false;
    } catch (error) {
        console.error('❌ Error checking subscription status:', error);
        // Default to allowing access if there's an error checking
        return false;
    }
}

// Check message limits for free tier users
async function checkMessageLimits(uid: string): Promise<boolean> {
    try {
        console.log('🔢 Checking message limits for user:', uid);
        
        const userRef = db.collection('users').doc(uid);
        let userDoc;
        
        try {
            userDoc = await userRef.get();
        } catch (error) {
            console.log('🔢 Error fetching user document for message limits:', error);
            // Default to allowing access if we can't check
            return true;
        }
        
        if (userDoc && userDoc.exists) {
            const userData = userDoc.data();
            const messageCount = userData?.messageCount || 0;
            const messageLimit = 30; // Free tier message limit
            
            console.log('🔢 User message count:', messageCount, 'limit:', messageLimit);
            
            // Return true if user is within limits
            return messageCount < messageLimit;
        }
        
        // Default to allowing if no user document exists yet
        console.log('🔢 No existing message count found, allowing as new user');
        return true;
    } catch (error) {
        console.error('❌ Error checking message limits:', error);
        // Default to allowing access if there's an error checking
        return true;
    }
}

// Chat History Function
export const getChatHistoryV2 = onCall({
  region: 'us-central1',
}, async (request) => {
    try {
        // Debug log
        console.log('📱 Fetching chat history...');
        
        // Check authentication
        if (!request.auth) {
            throw new Error('User must be authenticated');
        }
        
        const uid = request.auth.uid;
        console.log('👤 User authenticated:', { userId: uid, token: request.auth.token });
        
        try {
            console.log('🔍 Attempting to query Firestore users collection for user:', uid);
            const snapshot = await db
                .collection('users')
                .doc(uid)
                .collection('conversations')
                .orderBy('lastUpdated', 'desc')
                .limit(50)
                .get();
            
            console.log('✅ Firestore query successful with docs count:', snapshot.docs.length);
            
            const conversations = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            // Debug log
            console.log('📱 Chat history fetched successfully:', {
                userId: uid,
                conversationCount: conversations.length
            });
            
            return conversations;
        } catch (error) {
            console.error('❌ Error fetching chat history:', error);
            // Return empty array as fallback
            return [];
        }
    } catch (error) {
        console.error('❌ Error fetching chat history:', error);
        throw new Error('Failed to fetch chat history');
    }
});

// Chat Message Function
export const processChatMessageV2 = onCall({
    region: 'us-central1',
    secrets: [geminiSecretKey],
}, async (request) => {
    try {
        // Debug log
        console.log('💬 Processing chat message...');
        
        // Check authentication
        if (!request.auth) {
            throw new Error('User must be authenticated');
        }
        
        const data = request.data;
        
        // Validate message
        if (!data.message) {
            throw new Error('Message is required');
        }
        
        const { message, conversationId } = data;
        const uid = request.auth.uid;
        
        // Debug log with authentication info
        console.log('👤 User authenticated:', { 
            userId: uid,
            provider: request.auth.token.firebase?.sign_in_provider || 'unknown',
            email: request.auth.token.email || 'none'
        });
        
        // Check if user has premium subscription
        const isPremium = await checkUserSubscription(uid);
        console.log('💲 User subscription status:', isPremium ? 'Premium' : 'Free');
        
        // If user is not premium, check message limits
        if (!isPremium) {
            const withinLimits = await checkMessageLimits(uid);
            if (!withinLimits) {
                console.log('🚫 Free tier user has exceeded message limit');
                throw new Error('Message limit exceeded. Please upgrade to premium for unlimited messages.');
            }
        }
        
        // Debug log
        console.log('💬 Processing request:', {
            userId: uid,
            messageLength: message.length,
            conversationId: conversationId || 'new',
            subscription: isPremium ? 'Premium' : 'Free'
        });
        
        // Get or create conversation
        console.log('🔍 Creating conversation reference for user:', uid);
        const conversationRef = conversationId
            ? db
                .collection('users')
                .doc(uid)
                .collection('conversations')
                .doc(conversationId)
            : db
                .collection('users')
                .doc(uid)
                .collection('conversations')
                .doc();
        
        console.log('🔍 Attempting to get conversation document:', conversationRef.path);
        
        // Get conversation history
        let conversationData: ConversationData = { messages: [] };
        try {
            const conversationDoc = await conversationRef.get();
            if (conversationDoc.exists) {
                const data = conversationDoc.data();
                if (data && data.messages) {
                    conversationData = data as ConversationData;
                }
            }
            console.log('✅ Conversation document retrieved successfully');
        } catch (error) {
            console.log('⚠️ Error retrieving conversation document:', error);
            // Continue with empty conversation
        }
        
        // Add user message
        const userMessage = {
            role: 'user',
            content: message,
            timestamp: new Date().toISOString()
        };
        
        // Get API key from Secret Manager
        // Rule: Always add debug logs for easier debug
        console.log('🤖 Initializing Gemini AI with Secret Manager key...');
        
        try {
            // Get the API key using the defineSecret API
            const apiKey = geminiSecretKey.value();
            
            // Debug logs for the API key
            if (!apiKey) {
                console.error('❌ Gemini API key is not found');
                throw new Error('API key not found');
            }
            
            console.log('✅ Successfully retrieved API key, length:', apiKey.length);
            
            const genAI = new GoogleGenerativeAI(apiKey);
            // Updated model name - Gemini 1.5 Pro is the current model name
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
            
            // Generate response using Gemini
            console.log('🤖 Generating response with Gemini...');
            const result = await model.generateContent(message);
            const response = result.response.text();
            console.log('✅ Gemini response generated successfully');
            
            // Add assistant message
            const assistantMessage = {
                role: 'assistant',
                content: response,
                timestamp: new Date().toISOString()
            };
            
            // Update conversation
            try {
                console.log('📝 Updating conversation in Firestore:', conversationRef.path);
                await conversationRef.set({
                    messages: [...conversationData.messages, userMessage, assistantMessage],
                    lastUpdated: FieldValue.serverTimestamp()
                }, { merge: true });
                console.log('✅ Conversation updated successfully');
            } catch (error) {
                console.error('❌ Error updating conversation:', error);
                // Continue without saving conversation
            }
            
            // Update user's message count
            try {
                console.log('📝 Updating user message count in Firestore');
                await db
                    .collection('users')
                    .doc(uid)
                    .set({
                        messageCount: FieldValue.increment(1),
                        lastActive: FieldValue.serverTimestamp()
                    }, { merge: true });
                console.log('✅ User message count updated successfully');
            } catch (error) {
                console.error('❌ Error updating user message count:', error);
                // Continue without updating message count
            }
            
            // Debug log
            console.log('💬 Message processed successfully');
            
            return {
                role: 'assistant',
                message: response,
                response: response,
                conversationId: conversationRef.id
            };
        } catch (error) {
            console.error('❌ Error with Gemini API:', error);
            throw new Error('Failed to generate AI response. Please try again later.');
        }
    } catch (error) {
        console.error('❌ Error processing message:', error);
        throw new Error('Failed to process message');
    }
}); 