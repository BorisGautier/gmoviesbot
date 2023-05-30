import Twit from 'twit';
import request from 'request';
import * as admin from 'firebase-admin';

const T = new Twit({
  consumer_key: 'CONSUMER_KEY',
  consumer_secret: 'CONSUMER_SECRET',
  access_token: 'ACCESS_TOKEN',
  access_token_secret: 'ACCESS_TOKEN_SECRET'
});

const TMDB_API_KEY = 'TMDB_API_KEY';

admin.initializeApp();

const firestore = admin.firestore();
const cacheCollection = firestore.collection('cache');
const statisticsCollection = firestore.collection('statistics');

function searchMovie(description: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(description)}`;
    request(url, (error: any, response: any, body: any) => {
      if (error) {
        reject(error);
      } else {
        const movies = JSON.parse(body).results;
        if (movies.length > 0) {
          const title = movies[0].title;
          // On ajoute le titre du film dans Firestore avec une durée de validité de 24 heures
          const expirationDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
          cacheCollection.doc(description).set({ title, expirationDate });

          // On récupère l'URL de l'image du film pour publier celle-ci en réponse au tweet
          const imageUrl = `https://image.tmdb.org/t/p/original${movies[0].poster_path}`;

          // On publie la réponse personnalisée avec l'image et le titre du film
          postTweetWithImage(`Le film que vous recherchez est : "${title}"!`, imageUrl);

          resolve(title);
        } else {
          reject('No movie found');
        }
      }
    });
  });
}

async function handleTweet(tweet: Twit.Twitter.Status): Promise<void> {
  if (!tweet.retweeted_status && !tweet.quoted_status) {
    const description = tweet.text!
      .replace(/(?:https?|ftp):\/\/[\n\S]+/g, "")
      .trim();
    if (description.length > 0) {
      const cacheDoc = await cacheCollection.doc(description).get();
      if (
        cacheDoc.exists &&
        cacheDoc.data()?.expirationDate.toDate() > new Date()
      ) {
        // Si le titre est en cache et n'a pas expiré, on répond directement au tweet
        const title = cacheDoc.data()?.title;
        console.log(`Found movie "${title}" in cache for tweet: ${tweet.text}`);

        // On récupère l'URL de l'image du film pour publier celle-ci en réponse au tweet
        const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(
          title
        )}`;
        request(url, (error: any, response: any, body: any) => {
          if (error) {
            console.error(error);
          } else {
            const movies = JSON.parse(body).results;
            if (movies.length > 0) {
              const imageUrl = `https://image.tmdb.org/t/p/original${movies[0].poster_path}`;

              // On publie la réponse personnalisée avec l'image et le titre du film
              postTweetWithImage(
                `@${tweet.user.screen_name} The movie you're looking for is "${title}"!`,
                imageUrl
              );
            }
          }
        });

        // Mise à jour des statistiques
        const countryCode = tweet.user?.location
          ? tweet.user.location.substring(
              tweet.user.location.lastIndexOf(" ") + 1
            )
          : null;
        const statsRef = statisticsCollection.doc(title);
        const statsDoc = await statsRef.get();

        if (statsDoc.exists) {
          statsRef.update({
            count: statsDoc.data()?.count + 1,
            countries: admin.firestore.FieldValue.arrayUnion(countryCode),
            users: admin.firestore.FieldValue.arrayUnion(
              tweet.user.screen_name
            ),
          });
        } else {
          statsRef.set({
            count: 1,
            countries: [countryCode],
            users: [tweet.user.screen_name],
          });
        }
      } else {
        // Sinon, on effectue la recherche comme avant
        searchMovie(description)
          .then((title: string) => {
            console.log(`Found movie "${title}" for tweet: ${tweet.text}`);

            // On récupère l'URL de l'image du film pour publier celle-ci en réponse au tweet
            const url = `https://api        .themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(
              title
            )}`;
            request(url, (error: any, response: any, body: any) => {
              if (error) {
                console.error(error);
              } else {
                const movies = JSON.parse(body).results;
                if (movies.length > 0) {
                  const imageUrl = `https://image.tmdb.org/t/p/original${movies[0].poster_path}`;

                  // On publie la réponse personnalisée avec l'image et le titre du film
                  postTweetWithImage(
                    `@${tweet.user.screen_name} The movie you're looking for is "${title}"!`,
                    imageUrl
                  );
                }
              }
            });

            // Mise à jour des statistiques
            const countryCode = tweet.user?.location
              ? tweet.user.location.substring(
                  tweet.user.location.lastIndexOf(" ") + 1
                )
              : null;
            statisticsCollection.doc(title).set({
              count: 1,
              countries: [countryCode],
              users: [tweet.user.screen_name],
            });
          })
          .catch((error: any) => {
            console.error(error);
          });
      }
    }
  }
}

function postTweetWithImage(
  text: string,
  imageUrl: string
): Promise<Twit.Twitter.Status> {
  return new Promise((resolve, reject) => {
    request(imageUrl, { encoding: null }, (error, response, body) => {
      if (error) {
        reject(error);
      } else {
        T.post(
          "media/upload",
          { media_data: body.toString("base64") },
          function (err, data, response) {
            if (err) {
              reject(err);
            } else {
                //@ts-ignore
              const mediaIdStr = data.media_id_string;
              const params = { status: text, media_ids: [mediaIdStr] };
              T.post("statuses/update", params, function (err, data, response) {
                if (err) {
                  reject(err);
                } else {
                  //@ts-ignore
                  resolve(data);
                }
              });
            }
          }
        );
      }
    });
  });
}

const stream = T.stream("statuses/filter", { track: "@MyBotTwitter" });
stream.on("tweet", handleTweet);
